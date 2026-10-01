import { Bonjour } from 'bonjour-service';

/**
 * Advertise the server over mDNS/Bonjour: an `_http._tcp` service, and A records for
 * `<name>.local` so `http://<name>.local:<port>` resolves on phones, tablets and laptops.
 */
export function publish({ name, port, log = () => {} }) {
  let bonjour;
  try {
    bonjour = new Bonjour({}, (err) => log(`mDNS error: ${err?.message || err}`));
    const host = `${name}.local`;
    const service = bonjour.publish({
      name: `Shoebox (${name})`,
      type: 'http',
      port,
      host,
      txt: { path: '/' },
      probe: false,
    });
    service.on('error', (e) => log(`mDNS publish error: ${e?.message || e}`));
    return {
      host,
      stop: () =>
        new Promise((resolve) => {
          try {
            bonjour.unpublishAll(() => bonjour.destroy(() => resolve()));
            setTimeout(resolve, 1000);
          } catch {
            resolve();
          }
        }),
    };
  } catch (e) {
    log(`mDNS unavailable: ${e.message}`);
    try {
      bonjour?.destroy();
    } catch {}
    return null;
  }
}
