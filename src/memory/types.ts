/**
 * 记忆类型定义
 * 复刻 Claude Code 的四类分类法
 */

/** 记忆类型 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

/** 所有有效记忆类型 */
export const MEMORY_TYPES: readonly MemoryType[] = [
	'user',
	'feedback',
	'project',
	'reference',
] as const;

/** 解析记忆类型，无效值返回 undefined */
export function parseMemoryType(raw: unknown): MemoryType | undefined {
	if (typeof raw !== 'string') return undefined;
	return MEMORY_TYPES.find(t => t === raw);
}

/** 记忆文件头信息（扫描阶段产出） */
export interface MemoryHeader {
	filename: string;
	filePath: string;
	mtimeMs: number;
	description: string | null;
	type: MemoryType | undefined;
}

/** 完整记忆条目（含内容） */
export interface MemoryEntry extends MemoryHeader {
	content: string;
}

/** 记忆召回结果 */
export interface RecallResult {
	selected: MemoryEntry[];
	tokens: { input: number; output: number; cached: number };
	elapsed: number;
	method: 'llm' | 'keyword';
}

/** 记忆文件 frontmatter 示例 */
export const MEMORY_FRONTMATTER_EXAMPLE = [
	'```markdown',
	'---',
	'name: {{memory name}}',
	'description: {{one-line description}}',
	'type: {{user, feedback, project, reference}}',
	'---',
	'',
	'{{memory content}}',
	'```',
].join('\n');

/** 记忆类型说明（注入到召回 prompt 中） */
export const TYPES_GUIDANCE = `
## Types of memory
- user: User role, goals, responsibilities, knowledge level
- feedback: Guidance on work approach (corrections AND confirmations)
- project: Ongoing work context not derivable from code/git
- reference: Pointers to external systems and resources
`.trim();

/** 不应保存的内容 */
export const WHAT_NOT_TO_SAVE = `
## What NOT to save
- Code patterns, architecture, file paths (derivable from project)
- Git history, recent changes (use git log)
- Debugging solutions (the fix is in the code)
- Ephemeral task details
`.trim();
