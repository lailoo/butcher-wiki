// Translation utilities — read/write English translations for domains and solutions
// English translations are stored alongside originals:
//   knowledge/domains-en/PD-XX-slug.json  (domain metadata)
//   knowledge/solutions-en/PD-XX-Project-xxx.md  (solution docs)

import fs from 'fs';
import path from 'path';

const DOMAINS_EN_DIR = path.join(process.cwd(), 'knowledge', 'domains-en');
const SOLUTIONS_EN_DIR = path.join(process.cwd(), 'knowledge', 'solutions-en');

/** Current translation schema version. Bump when adding new required fields. */
const TRANSLATION_VERSION = 4;

export interface DomainTranslation {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  sub_problems: string[];
  best_practices: string[];
  comparison_dimensions?: { name: string; values: Record<string, string> }[];
  solutions?: { source_id: string; title: string; description: string; design_philosophy?: string[]; migration_scenarios?: string[] }[];
  _version?: number;
}

/** Read English translation for a domain, returns null if not found or outdated */
export function readDomainTranslation(domainId: string): DomainTranslation | null {
  if (!fs.existsSync(DOMAINS_EN_DIR)) return null;
  const files = fs.readdirSync(DOMAINS_EN_DIR);
  const file = files.find(f => f.startsWith(`${domainId}-`) && f.endsWith('.json'));
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DOMAINS_EN_DIR, file), 'utf-8'));
    // Re-translate if version is outdated (missing comparison_dimensions/solutions)
    if ((data._version ?? 0) < TRANSLATION_VERSION) return null;
    return data;
  } catch { return null; }
}

/** Write English translation for a domain */
export function writeDomainTranslation(domainId: string, slug: string, translation: DomainTranslation): void {
  if (!fs.existsSync(DOMAINS_EN_DIR)) {
    fs.mkdirSync(DOMAINS_EN_DIR, { recursive: true });
  }
  const filename = `${domainId}-${slug}.json`;
  const data = { ...translation, _version: TRANSLATION_VERSION };
  fs.writeFileSync(path.join(DOMAINS_EN_DIR, filename), JSON.stringify(data, null, 2), 'utf-8');
}

/** Read English translation for a solution doc, returns null if not found */
export function readSolutionTranslation(filename: string): string | null {
  const filePath = path.join(SOLUTIONS_EN_DIR, `${filename}.md`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch { return null; }
}

/** Write English translation for a solution doc */
export function writeSolutionTranslation(filename: string, content: string): void {
  if (!fs.existsSync(SOLUTIONS_EN_DIR)) {
    fs.mkdirSync(SOLUTIONS_EN_DIR, { recursive: true });
  }
  fs.writeFileSync(path.join(SOLUTIONS_EN_DIR, `${filename}.md`), content, 'utf-8');
}

/** Check if English translation exists for a domain */
export function hasDomainTranslation(domainId: string): boolean {
  return readDomainTranslation(domainId) !== null;
}

/** Check if English translation exists for a solution doc */
export function hasSolutionTranslation(filename: string): boolean {
  return fs.existsSync(path.join(SOLUTIONS_EN_DIR, `${filename}.md`));
}

/** Delete English translation for a domain (used when domain is updated) */
export function deleteDomainTranslation(domainId: string): void {
  if (!fs.existsSync(DOMAINS_EN_DIR)) return;
  const files = fs.readdirSync(DOMAINS_EN_DIR);
  const file = files.find(f => f.startsWith(`${domainId}-`) && f.endsWith('.json'));
  if (file) {
    fs.unlinkSync(path.join(DOMAINS_EN_DIR, file));
  }
}
