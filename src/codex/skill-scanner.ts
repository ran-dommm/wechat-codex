import { readdirSync, readFileSync, existsSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

function parseSkillMd(filePath: string): { name: string; description: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const frontmatter = match[1];
    const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    if (!nameMatch) return null;

    return {
      name: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
      description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, '') : '',
    };
  } catch {
    return null;
  }
}

function scanDirectory(baseDir: string, depth: number): SkillInfo[] {
  if (!existsSync(baseDir)) return [];

  let entries: Dirent[] = [];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = join(baseDir, entry.name);
    const skillFile = join(fullPath, 'SKILL.md');
    if (existsSync(skillFile)) {
      const skill = parseSkillMd(skillFile);
      if (skill) {
        skills.push({ ...skill, path: fullPath });
      }
    }
    if (depth > 1) {
      skills.push(...scanDirectory(fullPath, depth - 1));
    }
  }

  return skills;
}

export function scanAllSkills(): SkillInfo[] {
  const codexHome = join(homedir(), '.codex');
  const skills = [
    ...scanDirectory(join(codexHome, 'skills'), 2),
    ...scanDirectory(join(codexHome, 'superpowers', 'skills'), 1),
  ];

  const deduped = new Map<string, SkillInfo>();
  for (const skill of skills) {
    if (!deduped.has(skill.name.toLowerCase())) {
      deduped.set(skill.name.toLowerCase(), skill);
    }
  }
  return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(skills: SkillInfo[], name: string): SkillInfo | undefined {
  const lower = name.toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === lower);
}
