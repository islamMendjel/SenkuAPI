// SenkuAPI — safe serializers for API responses (keys never leave unmasked).

import { db } from "@/lib/db";
import { limiterStatus } from "./limiter";
import type { ProviderView, UsageSnapshot } from "./types";

export function maskKey(key: string): string {
  if (key.length <= 10) return "•".repeat(Math.max(key.length - 2, 4));
  return `${key.slice(0, 7)}${"•".repeat(8)}${key.slice(-4)}`;
}

export async function providerView(provider: {
  id: string;
  name: string;
  slug: string;
  baseUrl: string | null;
  hasTokenLimit: boolean;
  tokenLimitPerKey: number;
  tokenMultiplier: number;
  isActive: boolean;
  models: string;
}): Promise<ProviderView> {
  const keys = await db.apiKey.findMany({
    where: { providerId: provider.id },
    orderBy: { createdAt: "asc" },
  });
  const lifetime = await db.usageEvent.aggregate({
    _sum: { totalTokens: true },
    where: { providerId: provider.id },
  });
  return {
    id: provider.id,
    name: provider.name,
    slug: provider.slug,
    baseUrl: provider.baseUrl,
    hasTokenLimit: provider.hasTokenLimit,
    tokenLimitPerKey: provider.tokenLimitPerKey,
    tokenMultiplier: provider.tokenMultiplier,
    isActive: provider.isActive,
    models: JSON.parse(provider.models || "[]"),
    keys: keys.map((k) => ({
      id: k.id,
      label: k.label,
      masked: maskKey(k.keyValue),
      isActive: k.isActive,
      tokensUsedThisMonth: k.tokensUsedThisMonth,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    })),
    totalTokens: Math.round(
      (lifetime._sum.totalTokens ?? 0) * provider.tokenMultiplier
    ),
  };
}

export async function usageSnapshot(): Promise<UsageSnapshot> {
  const providers = await db.provider.findMany({
    orderBy: { createdAt: "asc" },
  });
  const views: ProviderView[] = [];
  for (const p of providers) views.push(await providerView(p));
  const active = views.find((v) => v.isActive) ?? views[0];
  const limiter = await limiterStatus(active);
  return { activeProvider: active, providers: views, limiter };
}
