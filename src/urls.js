export function createUrlMapper(upstreamOrigin, publicOrigin, aliases = []) {
  const upstream = new URL(upstreamOrigin);
  const publicUrl = new URL(publicOrigin);
  const sourceHosts = new Set([upstream.host, ...aliases.map((alias) => new URL(alias).host)]);
  const sourceHostnames = new Set([upstream.hostname, ...aliases.map((alias) => new URL(alias).hostname)]);

  function isSource(url) {
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && sourceHosts.has(url.host);
  }

  function mapUrl(value, base = upstream, absolute = false) {
    if (typeof value !== 'string' || !value.trim()) return value;
    const trimmed = value.trim();
    try {
      const url = new URL(trimmed, base);
      if (!isSource(url)) return value;
      if (!absolute && !/^(?:https?:)?\/\//i.test(trimmed)) return value;
      url.protocol = publicUrl.protocol;
      url.hostname = publicUrl.hostname;
      url.port = publicUrl.port;
      return url.href;
    } catch {
      return value;
    }
  }

  function mapText(text) {
    return text.replace(/(?:https?:)?\/\/[^\s<>"'`\\)\]},;]+/gi, (value) => {
      const mapped = mapUrl(value);
      return mapped !== value && /^(?:https?:)?\/\/[^/?#]+$/i.test(value) ? mapped.replace(/\/$/, '') : mapped;
    });
  }

  return { upstream, publicUrl, isSource, mapUrl, mapText,
    isSourceHostname: (hostname) => sourceHostnames.has(hostname.toLowerCase()) };
}