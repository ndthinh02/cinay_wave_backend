// Trust only the nearest proxy on Render. Other deployments must opt in explicitly.
// An explicit value always wins (including 0 for a directly exposed server).
export function proxyHops(env = process.env) {
  const value = env.TRUST_PROXY_HOPS?.trim();
  if (!value) return env.RENDER === "true" ? 1 : 0;
  if (!/^[0-5]$/.test(value))
    throw new Error("TRUST_PROXY_HOPS must be an integer from 0 to 5");
  return Number(value);
}
