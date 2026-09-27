export const CONFIG_DIR_NAME: string;
export function getAgentDir(): string;
export function buildSessionContext(entries: unknown[]): { messages: any[] };
export function keyHint(id: string, description: string): string;

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	disableModelInvocation?: boolean;
	[key: string]: unknown;
}
export function formatSkillsForPrompt(skills: Skill[]): string;

export interface ExtensionUIContext {
	notify?(message: string, level?: string): void;
	[key: string]: any;
}
export interface ExtensionContext {
	mode: any;
	ui?: ExtensionUIContext;
	model?: any;
	modelRegistry: any;
	sessionManager: any;
	getSystemPrompt(): string;
	[key: string]: any;
}
export interface ExtensionAPI {
	on(event: string, handler: (event: any, context: ExtensionContext) => any): void;
	registerProvider(name: string, config: any): void;
	registerTool<T>(definition: any): void;
	[key: string]: any;
}
