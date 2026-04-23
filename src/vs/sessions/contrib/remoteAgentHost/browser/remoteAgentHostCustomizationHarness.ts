/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { extname } from '../../../../base/common/path.js';
import { basename } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { AgentHostConfigKey, getAgentHostConfiguredCustomizations } from '../../../../platform/agentHost/common/agentHostCustomizationConfig.js';
import { agentHostUri } from '../../../../platform/agentHost/common/agentHostFileSystemProvider.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { AGENT_HOST_SCHEME, fromAgentHostUri, toAgentHostUri } from '../../../../platform/agentHost/common/agentHostUri.js';
import type { IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { ActionType } from '../../../../platform/agentHost/common/state/sessionActions.js';
import { CustomizationScopeKind, SessionCustomizationSource } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { type AgentInfo, type CustomizationRef, type RootState, type SessionCustomization, CustomizationStatus } from '../../../../platform/agentHost/common/state/sessionState.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { AICustomizationManagementSection, IAICustomizationWorkspaceService, type IStorageSourceFilter } from '../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { type IHarnessDescriptor, type ICustomizationItem, type ICustomizationItemAction, type ICustomizationItemProvider } from '../../../../workbench/contrib/chat/common/customizationHarnessService.js';
import { PromptsType } from '../../../../workbench/contrib/chat/common/promptSyntax/promptTypes.js';
import { PromptsStorage } from '../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import { BUILTIN_STORAGE } from '../../chat/common/builtinPromptsStorage.js';
import { AgentCustomizationSyncProvider } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentCustomizationSyncProvider.js';

export { AgentCustomizationSyncProvider as RemoteAgentSyncProvider } from '../../../../workbench/contrib/chat/browser/agentSessions/agentHost/agentCustomizationSyncProvider.js';

const REMOTE_HOST_GROUP = 'remote-host';
const REMOTE_CLIENT_GROUP = 'remote-client';

/**
 * Maps a plugin sub-directory name to the {@link PromptsType}
 * its files represent. Returns `undefined` for unknown directories.
 */
function promptsTypeForPluginDir(dir: string): PromptsType | undefined {
	switch (dir) {
		case 'rules': return PromptsType.instructions;
		case 'commands': return PromptsType.prompt;
		case 'agents': return PromptsType.agent;
		case 'skills': return PromptsType.skill;
		default: return undefined;
	}
}

/**
 * Strips conventional prompt file extensions so we can show `foo`
 * for `foo.prompt.md`, `foo.instructions.md`, etc.
 */
function stripPromptFileExtensions(filename: string): string {
	const ext = extname(filename);
	if (!ext) {
		return filename;
	}
	const stem = filename.slice(0, -ext.length);
	const dotInStem = stem.lastIndexOf('.');
	return dotInStem > 0 ? stem.slice(0, dotInStem) : stem;
}

interface IExpandedPlugin {
	readonly nonce: string | undefined;
	readonly children: readonly ICustomizationItem[];
}

/**
 * Maps a {@link CustomizationStatus} enum value to the string literal
 * expected by {@link ICustomizationItem.status}.
 */
function toStatusString(status: CustomizationStatus | undefined): 'loading' | 'loaded' | 'degraded' | 'error' | undefined {
	switch (status) {
		case CustomizationStatus.Loading: return 'loading';
		case CustomizationStatus.Loaded: return 'loaded';
		case CustomizationStatus.Degraded: return 'degraded';
		case CustomizationStatus.Error: return 'error';
		default: return undefined;
	}
}

function customizationKey(customization: CustomizationRef): string {
	const scope = customization.scope;
	return `${customization.uri}::${scope?.kind ?? CustomizationScopeKind.Host}::${scope?.workspace ?? ''}`;
}

function customizationItemKey(customization: CustomizationRef, source: SessionCustomizationSource | undefined): string {
	return source === SessionCustomizationSource.Client
		? `${customizationKey(customization)}::${source}`
		: customizationKey(customization);
}

/**
 * Owns the client-side UI commands for configuring plugins on a remote
 * agent host. The actual source of truth lives in the host's root config.
 */
export class RemoteAgentPluginController extends Disposable {
	readonly pluginActions: readonly ICustomizationItemAction[];

	constructor(
		private readonly _hostLabel: string,
		private readonly _connectionAuthority: string,
		private readonly _connection: IAgentConnection,
		@IFileDialogService private readonly _fileDialogService: IFileDialogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IAICustomizationWorkspaceService private readonly _workspaceService: IAICustomizationWorkspaceService,
	) {
		super();

		this.pluginActions = [
			{
				id: 'remoteAgentHost.addPlugin',
				label: localize('remoteAgentHost.addPlugin', "Add Remote Plugin"),
				tooltip: localize('remoteAgentHost.addPluginTooltip', "Add a plugin folder that already exists on this remote agent host."),
				icon: Codicon.add,
				run: () => this.addPluginForHost(),
			},
			{
				id: 'remoteAgentHost.addWorkspacePlugin',
				label: localize('remoteAgentHost.addWorkspacePlugin', "Add Workspace Plugin"),
				tooltip: localize('remoteAgentHost.addWorkspacePluginTooltip', "Add a plugin folder for the active remote workspace only."),
				icon: Codicon.folder,
				run: () => this.addPluginForWorkspace(),
			},
		];
	}

	async removeConfiguredPlugin(customizationToRemove: CustomizationRef): Promise<void> {
		const updated = this.getConfiguredCustomizations().filter(customization => customizationKey(customization) !== customizationKey(customizationToRemove));
		this.dispatchCustomizations(updated);
	}

	private getConfiguredCustomizations(): readonly CustomizationRef[] {
		const rootState = this._connection.rootState.value;
		if (!rootState || rootState instanceof Error) {
			return [];
		}

		return getAgentHostConfiguredCustomizations(rootState.config?.values);
	}

	private dispatchCustomizations(customizations: readonly CustomizationRef[]): void {
		this._connection.dispatch({
			type: ActionType.RootConfigChanged,
			config: {
				[AgentHostConfigKey.Customizations]: [...customizations],
			},
		});
	}

	private getWorkspaceScope(): { kind: CustomizationScopeKind.Workspace; workspace: string } | undefined {
		const projectRoot = this._workspaceService.getActiveProjectRoot();
		if (!projectRoot || projectRoot.scheme !== AGENT_HOST_SCHEME || projectRoot.authority !== this._connectionAuthority) {
			return undefined;
		}

		return {
			kind: CustomizationScopeKind.Workspace,
			workspace: fromAgentHostUri(projectRoot).toString(),
		};
	}

	private async pickRemotePluginFolder(title: string): Promise<URI | undefined> {
		try {
			const selected = await this._fileDialogService.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				title,
				availableFileSystems: [AGENT_HOST_SCHEME],
				defaultUri: agentHostUri(this._connectionAuthority, '/'),
			});
			return selected?.[0];
		} catch {
			return undefined;
		}
	}

	private async addPluginForHost(): Promise<void> {
		await this.addConfiguredPlugin({
			kind: CustomizationScopeKind.Host,
		});
	}

	private async addPluginForWorkspace(): Promise<void> {
		const scope = this.getWorkspaceScope();
		if (!scope) {
			this._notificationService.warn(localize(
				'remoteAgentHost.workspacePluginRequiresRemoteWorkspace',
				"Open or focus a session on {0} to add a workspace-scoped remote plugin.",
				this._hostLabel,
			));
			return;
		}

		await this.addConfiguredPlugin(scope);
	}

	private async addConfiguredPlugin(scope: { kind: CustomizationScopeKind.Host } | { kind: CustomizationScopeKind.Workspace; workspace: string }): Promise<void> {
		const selected = await this.pickRemotePluginFolder(localize('remoteAgentHost.selectPluginFolder', "Select Plugin Folder on {0}", this._hostLabel));
		if (!selected) {
			return;
		}

		const original = fromAgentHostUri(selected);
		const newCustomization: CustomizationRef = {
			uri: original.toString(),
			displayName: basename(original) || original.path,
			scope,
		};

		const current = this.getConfiguredCustomizations();
		const nextKey = customizationKey(newCustomization);
		if (current.some(customization => customizationKey(customization) === nextKey)) {
			this._notificationService.info(localize(
				'remoteAgentHost.pluginAlreadyConfigured',
				"'{0}' is already configured on {1}.",
				newCustomization.displayName,
				this._hostLabel,
			));
			return;
		}

		this.dispatchCustomizations([...current, newCustomization]);
	}
}

/**
 * Provider that exposes a remote agent's configured plugins as
 * {@link ICustomizationItem} entries for the plugin management widget.
 *
 * Each plugin is also **expanded** into its individual customization
 * files (agents, skills, instructions, prompts) by reading the plugin
 * directory through the agent-host filesystem provider. The expanded
 * children appear in per-type sections (Skills, Agents, etc.) while
 * the parent plugin item appears in the Plugins section.
 */
export class RemoteAgentCustomizationItemProvider extends Disposable implements ICustomizationItemProvider {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _agentCustomizations: readonly CustomizationRef[];
	private _sessionCustomizations: readonly SessionCustomization[] | undefined;

	/** Cache: pluginUri → last expansion (keyed by nonce so we re-fetch on content change). */
	private readonly _expansionCache = new ResourceMap<IExpandedPlugin>();

	constructor(
		private readonly _agentInfo: AgentInfo,
		private readonly _connection: IAgentConnection,
		private readonly _connectionAuthority: string,
		private readonly _controller: RemoteAgentPluginController,
		private readonly _fileService: IFileService,
		private readonly _logService: ILogService,
	) {
		super();
		this._agentCustomizations = this._readRootCustomizations(this._connection.rootState.value) ?? _agentInfo.customizations ?? [];

		this._register(this._connection.rootState.onDidChange(rootState => {
			const next = this._readRootCustomizations(rootState) ?? this._readAgentCustomizations(rootState) ?? this._agentCustomizations;
			if (next !== this._agentCustomizations) {
				this._agentCustomizations = next;
				this._onDidChange.fire();
			}
		}));

		this._register(this._connection.onDidAction(envelope => {
			if (envelope.action.type === ActionType.SessionCustomizationsChanged) {
				const customizations = (envelope.action as { customizations?: SessionCustomization[] }).customizations;
				if (customizations && customizations !== this._sessionCustomizations) {
					this._sessionCustomizations = customizations;
					this._onDidChange.fire();
				}
			}
		}));
	}

	private _readRootCustomizations(rootState: RootState | Error | undefined): readonly CustomizationRef[] | undefined {
		if (!rootState || rootState instanceof Error || !rootState.config) {
			return undefined;
		}

		return getAgentHostConfiguredCustomizations(rootState.config?.values);
	}

	private _readAgentCustomizations(rootState: RootState | Error | undefined): readonly CustomizationRef[] | undefined {
		if (!rootState || rootState instanceof Error) {
			return undefined;
		}

		return rootState.agents.find(agent => agent.provider === this._agentInfo.provider)?.customizations;
	}

	private toRemoteUri(customization: CustomizationRef): URI {
		return toAgentHostUri(URI.parse(customization.uri), this._connectionAuthority);
	}

	private toBadge(customization: CustomizationRef, source: SessionCustomizationSource | undefined): { badge?: string; badgeTooltip?: string; groupKey?: string } {
		if (source === SessionCustomizationSource.Client) {
			return {
				badge: localize('remoteAgentHost.syncedBadge', "Synced"),
				badgeTooltip: localize('remoteAgentHost.syncedBadgeTooltip', "This plugin is being synced from the connected client into the active remote session."),
				groupKey: REMOTE_CLIENT_GROUP,
			};
		}

		if (customization.scope?.kind === CustomizationScopeKind.Workspace && customization.scope.workspace) {
			return {
				badge: localize('remoteAgentHost.workspaceBadge', "Workspace"),
				badgeTooltip: localize('remoteAgentHost.workspaceBadgeTooltip', "This plugin is configured on the remote host for workspace {0}.", customization.scope.workspace),
				groupKey: REMOTE_HOST_GROUP,
			};
		}

		return {
			badge: localize('remoteAgentHost.hostBadge', "Remote Host"),
			badgeTooltip: localize('remoteAgentHost.hostBadgeTooltip', "This plugin is configured directly on the remote agent host."),
			groupKey: REMOTE_HOST_GROUP,
		};
	}

	private toItem(customization: CustomizationRef, sessionCustomization: SessionCustomization | undefined): ICustomizationItem {
		const source = sessionCustomization?.source;
		const badge = this.toBadge(customization, source);
		const actions = source === SessionCustomizationSource.Client
			? undefined
			: <const>[{
				id: 'remoteAgentHost.removeConfiguredPlugin',
				label: localize('remoteAgentHost.removeConfiguredPlugin', "Remove from Remote Host"),
				icon: Codicon.trash,
				run: () => this._controller.removeConfiguredPlugin(customization),
			}];

		return {
			itemKey: customizationItemKey(customization, source),
			uri: this.toRemoteUri(customization),
			type: 'plugin',
			name: customization.displayName,
			description: customization.description,
			storage: PromptsStorage.plugin,
			status: toStatusString(sessionCustomization?.status),
			statusMessage: sessionCustomization?.statusMessage,
			enabled: sessionCustomization?.enabled ?? true,
			badge: badge.badge,
			badgeTooltip: badge.badgeTooltip,
			groupKey: badge.groupKey,
			actions,
		};
	}

	async provideChatSessionCustomizations(token: CancellationToken): Promise<ICustomizationItem[]> {
		const items = new Map<string, ICustomizationItem>();

		// Build parent plugin items keyed by customization ref
		type PluginMeta = { item: ICustomizationItem; nonce: string | undefined; status: ReturnType<typeof toStatusString>; statusMessage: string | undefined; enabled: boolean | undefined };
		const plugins: PluginMeta[] = [];

		for (const customization of this._agentCustomizations) {
			const item = this.toItem(customization, undefined);
			items.set(customizationItemKey(customization, undefined), item);
			plugins.push({ item, nonce: customization.nonce, status: undefined, statusMessage: undefined, enabled: undefined });
		}

		for (const sessionCustomization of this._sessionCustomizations ?? []) {
			const item = this.toItem(sessionCustomization.customization, sessionCustomization);
			items.set(
				customizationItemKey(sessionCustomization.customization, sessionCustomization.source),
				item,
			);
			// Only expand host-side plugins (not client-synced ones)
			if (sessionCustomization.source !== SessionCustomizationSource.Client) {
				plugins.push({
					item,
					nonce: sessionCustomization.customization.nonce,
					status: toStatusString(sessionCustomization.status),
					statusMessage: sessionCustomization.statusMessage,
					enabled: sessionCustomization.enabled,
				});
			}
		}

		// Expand each plugin directory in parallel to discover individual
		// skills, agents, instructions, and prompts inside.
		const expansions = await Promise.all(plugins.map(p => this._expandPluginContents(p.item.uri, p.nonce, token)));
		if (token.isCancellationRequested) {
			return [];
		}

		for (let i = 0; i < plugins.length; i++) {
			const p = plugins[i];
			for (const child of expansions[i]) {
				// Children inherit the parent plugin's status/enabled state.
				items.set(`${p.item.itemKey ?? p.item.uri.toString()}::${child.type}::${child.name}`, {
					...child,
					status: p.status,
					statusMessage: p.statusMessage,
					enabled: p.enabled,
				});
			}
		}

		return [...items.values()];
	}

	/**
	 * Reads a plugin's directory contents through the agent-host
	 * filesystem provider and returns one {@link ICustomizationItem} per
	 * supported file (agents/skills/instructions/prompts).
	 *
	 * Cached by `(uri, nonce)`; a different nonce invalidates the entry.
	 */
	private async _expandPluginContents(pluginUri: URI, nonce: string | undefined, token: CancellationToken): Promise<readonly ICustomizationItem[]> {
		const cached = this._expansionCache.get(pluginUri);
		if (cached && cached.nonce === nonce) {
			return cached.children;
		}

		const fsRoot = toAgentHostUri(pluginUri, this._connectionAuthority);
		const children: ICustomizationItem[] = [];
		try {
			if (!await this._fileService.canHandleResource(fsRoot)) {
				return [];
			}
			if (token.isCancellationRequested) {
				return [];
			}

			const dirNames = ['agents', 'skills', 'commands', 'rules'] as const;
			const subdirs = dirNames.map(name => ({ name, resource: URI.joinPath(fsRoot, name) }));
			const stats = await this._fileService.resolveAll(subdirs.map(s => ({ resource: s.resource })));

			if (token.isCancellationRequested) {
				return [];
			}

			for (let i = 0; i < subdirs.length; i++) {
				const stat = stats[i];
				if (!stat.success || !stat.stat?.isDirectory || !stat.stat.children) {
					continue;
				}
				const promptType = promptsTypeForPluginDir(subdirs[i].name);
				if (!promptType) {
					continue;
				}
				children.push(...this._collectFromTypeDir(stat.stat.children, promptType));
			}
			children.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
		} catch (err) {
			this._logService.trace(`[RemoteAgentCustomizationItemProvider] Failed to expand plugin ${pluginUri.toString()}: ${err}`);
			return [];
		}

		this._expansionCache.set(pluginUri, { nonce, children });
		return children;
	}

	/**
	 * Emits one {@link ICustomizationItem} per child of a per-type
	 * sub-folder. Skills are conventionally folders containing
	 * `SKILL.md`, but the local-sync bundler writes them as flat files;
	 * both layouts are accepted.
	 */
	private _collectFromTypeDir(entries: readonly { name: string; resource: URI; isDirectory: boolean }[], promptType: PromptsType): ICustomizationItem[] {
		const items: ICustomizationItem[] = [];
		for (const child of entries) {
			let displayName: string;
			if (promptType === PromptsType.skill) {
				displayName = child.isDirectory ? child.name : stripPromptFileExtensions(child.name);
			} else {
				if (child.isDirectory) {
					continue;
				}
				displayName = stripPromptFileExtensions(child.name);
			}
			items.push({
				uri: child.resource,
				type: promptType,
				name: displayName,
				storage: PromptsStorage.plugin,
				groupKey: REMOTE_HOST_GROUP,
			});
		}
		return items;
	}
}

/**
 * Creates a {@link IHarnessDescriptor} for a remote agent discovered via
 * the agent host protocol.
 */
export function createRemoteAgentHarnessDescriptor(
	harnessId: string,
	displayName: string,
	controller: RemoteAgentPluginController,
	itemProvider: RemoteAgentCustomizationItemProvider,
	syncProvider: AgentCustomizationSyncProvider,
): IHarnessDescriptor {
	const allSources = [PromptsStorage.local, PromptsStorage.user, PromptsStorage.plugin, BUILTIN_STORAGE];
	const filter: IStorageSourceFilter = { sources: allSources };

	return {
		id: harnessId,
		label: displayName,
		icon: ThemeIcon.fromId(Codicon.remote.id),
		hiddenSections: [
			AICustomizationManagementSection.Models,
			AICustomizationManagementSection.McpServers,
		],
		hideGenerateButton: true,
		getStorageSourceFilter(_type: PromptsType): IStorageSourceFilter {
			return filter;
		},
		itemProvider,
		syncProvider,
		pluginActions: controller.pluginActions,
	};
}
