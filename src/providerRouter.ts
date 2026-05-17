import type { HeaderRouteRule, RoutingRules } from "./config.js";

export type ProviderResolution = {
  provider?: string;
  upstreamBaseUrl: string;
  rewrittenPath: string;
  routeStrategy: "providerPrefix" | "pathPrefix" | "header";
};

function normalizeTargetMap(targets: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [provider, target] of Object.entries(targets)) {
    map.set(provider.toLowerCase(), target.replace(/\/+$/, ""));
  }
  return map;
}

export function resolveProviderRoute(path: string, providerTargets: Record<string, string>): ProviderResolution | undefined {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  const targets = normalizeTargetMap(providerTargets);
  const providerIndex = segments.findIndex((segment, idx) => {
    if (idx > 1) {
      return false;
    }
    return targets.has(segment.toLowerCase());
  });

  if (providerIndex < 0) {
    return undefined;
  }

  const providerSegment = segments[providerIndex];
  if (!providerSegment) {
    return undefined;
  }
  const provider = providerSegment.toLowerCase();
  const target = targets.get(provider);
  if (!target) {
    return undefined;
  }

  const rewrittenSegments = [...segments];
  rewrittenSegments.splice(providerIndex, 1);
  const rewrittenPath = `/${rewrittenSegments.join("/")}`;

  return {
    provider,
    upstreamBaseUrl: target,
    rewrittenPath,
    routeStrategy: "providerPrefix"
  };
}

export function resolveByHeader(
  headers: Record<string, string | string[] | undefined>,
  rules: HeaderRouteRule[],
  path: string
): ProviderResolution | undefined {
  for (const rule of rules) {
    const value = headers[rule.header] ?? headers[rule.header.toLowerCase()] ?? headers[rule.header.toUpperCase()];
    const normalizedValue = Array.isArray(value) ? value[0] : value;
    if (normalizedValue === rule.value) {
      return {
        upstreamBaseUrl: rule.target.replace(/\/+$/, ""),
        rewrittenPath: path.startsWith("/") ? path : `/${path}`,
        routeStrategy: "header"
      };
    }
  }
  return undefined;
}

export function resolveByPathPrefix(path: string, rules: Record<string, string>): ProviderResolution | undefined {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const matched = Object.entries(rules)
    .filter(([prefix]) => normalizedPath.startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length)[0];

  if (!matched) {
    return undefined;
  }

  const [prefix, target] = matched;
  const rewrittenPath = normalizedPath.slice(prefix.length);
  return {
    upstreamBaseUrl: target.replace(/\/+$/, ""),
    rewrittenPath: rewrittenPath.startsWith("/") ? rewrittenPath : `/${rewrittenPath}`,
    routeStrategy: "pathPrefix"
  };
}

export function resolveConfiguredRoute(
  path: string,
  headers: Record<string, string | string[] | undefined>,
  rules: RoutingRules
): ProviderResolution | undefined {
  const byHeader = resolveByHeader(headers, rules.headers, path);
  if (byHeader) {
    const byPrefix = resolveByPathPrefix(path, rules.pathPrefixes);
    if (byPrefix && byPrefix.upstreamBaseUrl === byHeader.upstreamBaseUrl) {
      return { ...byHeader, rewrittenPath: byPrefix.rewrittenPath };
    }
    return byHeader;
  }
  return resolveByPathPrefix(path, rules.pathPrefixes);
}
