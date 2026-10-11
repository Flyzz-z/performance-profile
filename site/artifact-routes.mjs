import path from "node:path";

export const ARTIFACT_ROUTES = [
  { prefix: "artifacts/mysql/", directory: "../benchmarks/mysql/results" },
  { prefix: "artifacts/redis/", directory: "../benchmarks/redis/results" },
];

export function resolveSitePath(siteRoot, relativePath) {
  const route = ARTIFACT_ROUTES.find(item => relativePath.startsWith(item.prefix));
  const fileRoot = route ? path.resolve(siteRoot, route.directory) : siteRoot;
  const requested = route ? relativePath.slice(route.prefix.length) : relativePath;
  const filePath = path.resolve(fileRoot, requested);
  const inside = path.relative(fileRoot, filePath);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return null;
  return filePath;
}
