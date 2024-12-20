import { createLibp2p, Libp2p } from "libp2p";
import { loadOrCreatePeerId } from "./peer-helper.js";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { tcp } from "@libp2p/tcp";
import {
  circuitRelayTransport,
  circuitRelayServer,
} from "@libp2p/circuit-relay-v2";
import { identify, identifyPush } from "@libp2p/identify";
import { roles } from "../services/roles/index.js";
import { MessagesService, MessagesServiceComponents } from "../services/messages/index.js";
import { peerList } from "../services/peer-list/index.js";
import { maList } from "../services/multiadress/index.js";
import { store } from "../services/store/index.js";
import { ConfigLoader, Config } from "../../common/config-loader.js";
import { injectable, inject } from "inversify";
import { TYPES } from './../../types.js';

@injectable()
export class p2pClientHelper {
  private config: Config;
  constructor(@inject(TYPES.ConfigLoader) configLoader: ConfigLoader,
    @inject(TYPES.MessagesServiceFactory)
    private messageFactory: (components: MessagesServiceComponents) => MessagesService) {
    this.config = configLoader.getConfig();
  }

  async getRelayClient(
    lintenAddrs: string[],
    port: number
  ): Promise<Libp2p> {
    try {
      const net = this.config.net;
      const privateKey = await loadOrCreatePeerId(`./data/${net}/peer-id.bin`);
      if (!privateKey) {
        throw new Error("Error loading or creating Peer ID");
      }
      const addrs = lintenAddrs.map((addr: string) => `${addr}${port}`);
      const node = await createLibp2p({
        start: false,
        privateKey: privateKey,
        addresses: {
          listen: addrs,
        },
        transports: [
          tcp(),
          circuitRelayTransport({
            maxInboundStopStreams: 128,
            maxOutboundStopStreams: 128,
            stopTimeout: 60000,
            reservationCompletionTimeout: 20000,
          }),
        ],
        connectionGater: {
          denyDialMultiaddr: () => {
            return false;
          },
        },
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
          relay: circuitRelayServer({
            maxInboundHopStreams: 128,
            maxOutboundStopStreams: 128,
            reservations: {
              maxReservations: 128,
              defaultDurationLimit: 600000,
              defaultDataLimit: BigInt(1 << 24),
            },
          }),
          pubsub: gossipsub(),
          identify: identify(),
          identifyPush: identifyPush(),
          store: store(),
          roles: roles({
            roles: [this.config.roles.RELAY],
          }),
          peerList: peerList(),
          maList: maList(),
          messages: this.messageFactory,
        },
        connectionManager: {
          maxConnections: 128,
        },
      });
      return node;
    } catch (error) {
      throw new Error(`Error during createLibp2p: ${error}`);
    }
  }
  async getNodeClient(
    lintenAddrs: string[],
    port: number
  ): Promise<Libp2p> {
    try {
      const privateKey = await loadOrCreatePeerId(
        `./data/${this.config.net}/peer-id.bin`
      );
      if (!privateKey) {
        throw new Error("Error loading or creating Peer ID");
      }

      const addrs = lintenAddrs.map((addr: string) => `${addr}${port}`);
      addrs.push("/p2p-circuit");
      const node = await createLibp2p({
        start: false,
        privateKey: privateKey,
        addresses: {
          listen: addrs,
        },
        transports: [
          tcp(),
          circuitRelayTransport({
            maxInboundStopStreams: 128,
            maxOutboundStopStreams: 128,
            stopTimeout: 60000,
            reservationCompletionTimeout: 20000,
          }),
        ],
        connectionGater: {
          denyDialMultiaddr: () => {
            return false;
          },
        },
        connectionEncrypters: [noise()],
        streamMuxers: [yamux()],
        services: {
          relay: circuitRelayServer({
            maxInboundHopStreams: 128,
            maxOutboundStopStreams: 128,
            reservations: {
              maxReservations: 128,
              defaultDurationLimit: 600000,
              defaultDataLimit: BigInt(1 << 24),
            },
          }),
          pubsub: gossipsub(),
          identify: identify(),
          identifyPush: identifyPush(),
          store: store(),
          roles: roles({
            roles: [this.config.roles.NODE],
          }),
          peerList: peerList(),
          maList: maList(),
          messages: this.messageFactory,
        },
        connectionManager: {
          maxConnections: 128,
        },
      });
      return node;
    } catch (error) {
      throw new Error(`Error during createLibp2p: ${error}`);
    }
  }
}