export function displayProgramEventTitle(title: string): string {
  const match = title.match(/^\[Connector\/(hook|notify)\]\s+(Codex|Claude Code):\s+(agent-turn-complete|agent-turn-completed)$/i);
  if (!match) return title;
  return `[Connector/${match[1]}] ${match[2]} 任务已完成`;
}
