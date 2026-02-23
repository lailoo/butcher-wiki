import { NextRequest, NextResponse } from 'next/server';
import { getDomainById, invalidateDomainsCache } from '@/data/domains';
import { updateDomainDef } from '@/lib/scan-domains';
import { translateDomainBackground } from '@/lib/translate-background';
import { deleteDomainTranslation } from '@/lib/translate-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_ICONS = new Set([
  'brain', 'network', 'shield', 'wrench', 'box', 'database', 'check-circle',
  'search', 'user-check', 'layers', 'activity', 'zap', 'knife', 'sparkles',
  'message-circle', 'eye', 'lock', 'cpu', 'globe', 'file-text', 'terminal',
  'refresh-cw', 'clock', 'link', 'settings', 'alert-triangle', 'code', 'git-branch',
]);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, ...updates } = body;

    if (!id || typeof id !== 'string') {
      return NextResponse.json({ error: '缺少域 ID' }, { status: 400 });
    }

    const domain = getDomainById(id);
    if (!domain) {
      return NextResponse.json({ error: `域 ${id} 不存在` }, { status: 404 });
    }

    // 校验 icon
    if (updates.icon && !VALID_ICONS.has(updates.icon)) {
      delete updates.icon;
    }

    // 校验 color
    if (updates.color && !/^#[0-9a-fA-F]{6}$/.test(updates.color)) {
      delete updates.color;
    }

    // 校验 severity
    if (updates.severity && !['critical', 'high', 'medium'].includes(updates.severity)) {
      delete updates.severity;
    }

    updateDomainDef(id, domain.slug, updates);
    invalidateDomainsCache();

    // Re-translate to English after update (fire-and-forget)
    deleteDomainTranslation(id);
    translateDomainBackground(id, updates.slug || domain.slug).catch(() => {});

    return NextResponse.json({ ok: true, id });
  } catch (error: unknown) {
    console.error('Domain update error:', error);
    const message = error instanceof Error ? error.message : '更新失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
