import * as os from "node:os";

import { Bonjour, Service } from "bonjour-service";

/** Bonjour/mDNS service type the Chat API is advertised under: `_continuejv._tcp` */
export const CHAT_API_MDNS_TYPE = "continuejv";

/**
 * Advertises the Chat API server on the local network via Bonjour/mDNS so
 * clients (e.g. the iOS app) can auto-discover it instead of typing an IP.
 *
 * Only useful when the server is bound to a non-loopback host - callers
 * should skip advertising for 127.0.0.1/localhost, since discovered clients
 * on other devices couldn't reach it anyway.
 */
export class MdnsAdvertiser {
  private bonjour?: Bonjour;
  private service?: Service;

  advertise(port: number, log: (message: string) => void): void {
    this.stop();
    const name = `Continue JV (${os.hostname()})`;
    this.bonjour = new Bonjour();
    this.service = this.bonjour.publish({
      name,
      type: CHAT_API_MDNS_TYPE,
      port,
      txt: {
        ws: "/ws",
        events: "/events",
        api: "1",
      },
    });
    this.service.on("error", (e: Error) => {
      log(`mDNS advertising error: ${e.message}`);
    });
    log(
      `Advertising Chat API via Bonjour as "${name}" (_${CHAT_API_MDNS_TYPE}._tcp, port ${port})`,
    );
  }

  stop(): void {
    this.service?.stop?.();
    this.service = undefined;
    this.bonjour?.destroy();
    this.bonjour = undefined;
  }
}
