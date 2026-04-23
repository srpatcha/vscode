/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { type IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { ActionType, type ActionEnvelope, type INotification, type StateAction } from '../../../../../platform/agentHost/common/state/sessionActions.js';
import { CustomizationScopeKind, SessionCustomizationSource, type AgentInfo, type CustomizationRef, type RootState, type SessionCustomization } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAICustomizationWorkspaceService } from '../../../../../workbench/contrib/chat/common/aiCustomizationWorkspaceService.js';
import { RemoteAgentCustomizationItemProvider, RemoteAgentPluginController } from '../../browser/remoteAgentHostCustomizationHarness.js';

class MockAgentConnection extends mock<IAgentConnection>() {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidAction = new Emitter<ActionEnvelope>();
	override readonly onDidAction = this._onDidAction.event;
	override readonly onDidNotification = Event.None as Event<INotification>;
	override readonly clientId = 'test-client';

	private _rootStateValue: RootState = { agents: [] };
	override readonly rootState;

	readonly dispatchedActions: StateAction[] = [];

	constructor() {
		super();
		const self = this;
		this.rootState = {
			get value(): RootState { return self._rootStateValue; },
			get verifiedValue(): RootState { return self._rootStateValue; },
			onDidChange: Event.None,
			onWillApplyAction: Event.None,
			onDidApplyAction: Event.None,
		};
	}

	setRootState(rootState: RootState): void {
		this._rootStateValue = rootState;
	}

	override dispatch(action: StateAction): void {
		this.dispatchedActions.push(action);
	}

	fireAction(envelope: ActionEnvelope): void {
		this._onDidAction.fire(envelope);
	}

	dispose(): void {
		this._onDidAction.dispose();
	}
}

function createNotificationService(): INotificationService {
	return new class extends mock<INotificationService>() {
		override error(): never {
			throw new Error('Unexpected notification error');
		}
	};
}

function createAgentInfo(customizations: readonly CustomizationRef[]): AgentInfo {
	return {
		provider: 'copilotcli',
		displayName: 'Copilot',
		description: 'Test Agent',
		models: [],
		customizations: [...customizations],
	};
}

suite('RemoteAgentHostCustomizationHarness', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('removeConfiguredPlugin keeps sibling scopes for the same URI', async () => {
		const connection = disposables.add(new MockAgentConnection());
		const controller = disposables.add(new RemoteAgentPluginController(
			'Test Host',
			'test-authority',
			connection,
			{} as IFileDialogService,
			createNotificationService(),
			{} as IAICustomizationWorkspaceService,
		));
		const hostScoped: CustomizationRef = { uri: 'file:///plugins/shared', displayName: 'Shared Plugin' };
		const workspaceScoped: CustomizationRef = {
			uri: 'file:///plugins/shared',
			displayName: 'Shared Plugin',
			scope: {
				kind: CustomizationScopeKind.Workspace,
				workspace: 'file:///workspace',
			},
		};
		connection.setRootState({
			agents: [],
			config: {
				schema: { type: 'object', properties: {} },
				values: { customizations: [hostScoped, workspaceScoped] },
			},
		});

		await controller.removeConfiguredPlugin(hostScoped);

		assert.deepStrictEqual(connection.dispatchedActions, [{
			type: ActionType.RootConfigChanged,
			config: {
				customizations: [workspaceScoped],
			},
		}]);
	});

	test('provider assigns distinct item keys to scope-distinct remote plugins', async () => {
		const connection = disposables.add(new MockAgentConnection());
		const controller = disposables.add(new RemoteAgentPluginController(
			'Test Host',
			'test-authority',
			connection,
			{} as IFileDialogService,
			createNotificationService(),
			{} as IAICustomizationWorkspaceService,
		));
		const hostScoped: CustomizationRef = { uri: 'file:///plugins/shared', displayName: 'Shared Plugin' };
		const workspaceScoped: CustomizationRef = {
			uri: 'file:///plugins/shared',
			displayName: 'Shared Plugin',
			scope: {
				kind: CustomizationScopeKind.Workspace,
				workspace: 'file:///workspace',
			},
		};

		connection.setRootState({
			agents: [createAgentInfo([hostScoped, workspaceScoped])],
		});

		const fileService = new class extends mock<IFileService>() {
			override async canHandleResource() { return false; }
			override async resolveAll() { return []; }
		};

		const provider = disposables.add(new RemoteAgentCustomizationItemProvider(
			createAgentInfo([hostScoped, workspaceScoped]),
			connection,
			'test-authority',
			controller,
			fileService,
			new NullLogService(),
		));

		const items = await provider.provideChatSessionCustomizations(CancellationToken.None);
		assert.strictEqual(items.length, 2);
		assert.notStrictEqual(items[0].itemKey, items[1].itemKey);
	});

	test('provider keeps client-synced entries distinct from host-owned entries', async () => {
		const connection = disposables.add(new MockAgentConnection());
		const controller = disposables.add(new RemoteAgentPluginController(
			'Test Host',
			'test-authority',
			connection,
			{} as IFileDialogService,
			createNotificationService(),
			{} as IAICustomizationWorkspaceService,
		));
		const hostScoped: CustomizationRef = { uri: 'file:///plugins/shared', displayName: 'Shared Plugin' };
		const synced: SessionCustomization = {
			customization: hostScoped,
			source: SessionCustomizationSource.Client,
			enabled: true,
		};

		connection.setRootState({
			agents: [createAgentInfo([hostScoped])],
		});

		const fileService = new class extends mock<IFileService>() {
			override async canHandleResource() { return false; }
			override async resolveAll() { return []; }
		};

		const provider = disposables.add(new RemoteAgentCustomizationItemProvider(
			createAgentInfo([hostScoped]),
			connection,
			'test-authority',
			controller,
			fileService,
			new NullLogService(),
		));

		connection.fireAction({
			serverSeq: 1,
			origin: undefined,
			action: {
				type: ActionType.SessionCustomizationsChanged,
				session: 'agent://copilotcli/session-1',
				customizations: [synced],
			},
		});

		const items = await provider.provideChatSessionCustomizations(CancellationToken.None);
		assert.strictEqual(items.length, 2);
		assert.notStrictEqual(items[0].itemKey, items[1].itemKey);
	});
});
