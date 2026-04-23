/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { createSchema, schemaProperty } from './agentHostSchema.js';
import { CustomizationScopeKind, type CustomizationRef } from './state/protocol/state.js';

/**
 * Well-known root-config keys used by the platform to configure agent-host
 * customizations.
 */
export const enum AgentHostConfigKey {
	/** Host-owned Open Plugins available to remote sessions. */
	Customizations = 'customizations',
}

export const agentHostCustomizationConfigSchema = createSchema({
	[AgentHostConfigKey.Customizations]: schemaProperty<CustomizationRef[]>({
		type: 'array',
		title: localize('agentHost.config.customizations.title', "Plugins"),
		description: localize('agentHost.config.customizations.description', "Plugins configured on this agent host and available to remote sessions."),
		default: [],
		items: {
			type: 'object',
			title: localize('agentHost.config.customizations.itemTitle', "Plugin"),
			properties: {
				uri: {
					type: 'string',
					title: localize('agentHost.config.customizations.uri', "Plugin URI"),
				},
				displayName: {
					type: 'string',
					title: localize('agentHost.config.customizations.displayName', "Name"),
				},
				description: {
					type: 'string',
					title: localize('agentHost.config.customizations.descriptionField', "Description"),
				},
				scope: {
					type: 'object',
					title: localize('agentHost.config.customizations.scope', "Scope"),
					properties: {
						kind: {
							type: 'string',
							title: localize('agentHost.config.customizations.scopeKind', "Scope"),
							enum: [CustomizationScopeKind.Host, CustomizationScopeKind.Workspace],
						},
						workspace: {
							type: 'string',
							title: localize('agentHost.config.customizations.workspace', "Workspace Folder"),
							description: localize('agentHost.config.customizations.workspaceDescription', "Workspace folder URI this plugin applies to when scope is set to Workspace."),
						},
					},
					required: ['kind'],
				},
			},
			required: ['uri', 'displayName'],
		},
	}),
});

export const defaultAgentHostCustomizationConfigValues = {
	[AgentHostConfigKey.Customizations]: [] as CustomizationRef[],
};

export function getAgentHostConfiguredCustomizations(values: Record<string, unknown> | undefined): readonly CustomizationRef[] {
	const raw = values?.[AgentHostConfigKey.Customizations];
	return agentHostCustomizationConfigSchema.validate(AgentHostConfigKey.Customizations, raw)
		? raw
		: defaultAgentHostCustomizationConfigValues[AgentHostConfigKey.Customizations];
}

export function customizationMatchesDirectory(customization: CustomizationRef, directory: URI | undefined): boolean {
	if (!customization.scope || customization.scope.kind === CustomizationScopeKind.Host) {
		return true;
	}

	const workspace = customization.scope.workspace;
	if (!directory || !workspace) {
		return false;
	}

	return isEqualOrParent(directory, URI.parse(workspace));
}
