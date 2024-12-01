import { OutOfLimitError } from "../../models/out-of-limit-error.js";
import { TimeoutError, TypedEventEmitter } from "@libp2p/interface";
import type { IncomingStreamData } from "@libp2p/interface-internal";
import { sendDebug } from "../socket-service.js";
import { LogLevel } from "../../helpers/log-level.js";
import protobuf from "protobufjs";
import { pbStream } from "it-protobuf-stream";
import { Uint8ArrayList } from "uint8arraylist";
import {
  PROTOCOL_PREFIX,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  TIMEOUT,
  MAX_INBOUND_STREAMS,
  MAX_OUTBOUND_STREAMS,
  MESSAGE_EXPIRATION_TIME,
} from "./constants.js";
import { MessageChain } from "./index.js";
import type {
  MessagesServiceComponents,
  MessagesServiceInit,
  MessagesService as MessagesServiceInterface,
  MessageServiceEvents,
} from "./index.js";
import type { Logger, Startable, Connection } from "@libp2p/interface";

export class MessagesService
  extends TypedEventEmitter<MessageServiceEvents>
  implements Startable, MessagesServiceInterface
{
  public readonly protocol: string;
  private readonly components: MessagesServiceComponents;
  private started: boolean;
  private readonly timeout: number;
  private readonly maxInboundStreams: number;
  private readonly maxOutboundStreams: number;
  private readonly runOnLimitedConnection: boolean;
  private readonly logger: Logger;
  private readonly log = (level: LogLevel, message: string) => {
    const timestamp = new Date();
    sendDebug("libp2p:messages", level, timestamp, message);
    this.logger(`[${timestamp.toISOString().slice(11, 23)}] ${message}`);
  };
  private messageHistory: Map<string, MessageChain> = new Map();
  private proto_root?: protobuf.Root;

  constructor(
    components: MessagesServiceComponents,
    init: MessagesServiceInit = {}
  ) {
    super();
    this.components = components;
    this.logger = components.logger.forComponent("@libp2p/messages");
    this.started = false;
    this.protocol = `/${
      init.protocolPrefix ?? PROTOCOL_PREFIX
    }/${PROTOCOL_NAME}/${PROTOCOL_VERSION}`;
    this.timeout = init.timeout ?? TIMEOUT;
    this.maxInboundStreams = init.maxInboundStreams ?? MAX_INBOUND_STREAMS;
    this.maxOutboundStreams = init.maxOutboundStreams ?? MAX_OUTBOUND_STREAMS;
    this.runOnLimitedConnection = init.runOnLimitedConnection ?? true;
    this.handleMessage = this.handleMessage.bind(this);
  }

  async start(): Promise<void> {
    this.log(LogLevel.Info, "Starting store service");
    await this.components.registrar.handle(this.protocol, this.handleMessage, {
      maxInboundStreams: this.maxInboundStreams,
      maxOutboundStreams: this.maxOutboundStreams,
      runOnLimitedConnection: this.runOnLimitedConnection,
    });
    this.proto_root = await protobuf.load("message_chain.proto");
    this.started = true;
    this.log(LogLevel.Info, "Started store service");
    setTimeout(() => {
      this.clearMessageHistory();
    }, 1000);
  }

  private clearMessageHistory() {
    for (const [key, message] of this.messageHistory) {
      if (Date.now() - message.dt > MESSAGE_EXPIRATION_TIME) {
        this.messageHistory.delete(key);
      }
    }
    setTimeout(() => {
      this.clearMessageHistory();
    }, 1000);
  }

  async stop(): Promise<void> {
    await this.components.registrar.unhandle(this.protocol);
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  async handleMessage(data: IncomingStreamData): Promise<void> {
    const { stream, connection } = data;
    this.log(LogLevel.Info, `Incoming message from ${connection.remotePeer}`);

    try {
      if (!this.proto_root) {
        throw new Error("Proto root is not loaded");
      }

      const root = this.proto_root;
      const ProtobufMessageChain = root.lookupType("MessageChain");

      // Настраиваем pbStream
      const pbstr = pbStream(stream);

      // Устанавливаем таймаут
      const signal = AbortSignal.timeout(this.timeout);
      signal.addEventListener("abort", () => {
        this.log(LogLevel.Warning, "Timeout reached, aborting stream");
        stream.abort(new TimeoutError("Timeout during handleMessage"));
      });

      let decodedMessage: any;

      while (true) {
        try {
          // Читаем следующее сообщение из потока
          const messageData = await pbstr.read(
            {
              decode: (data: Uint8ArrayList | Uint8Array) => {
                // Преобразуем Uint8ArrayList в Uint8Array, если необходимо
                const buffer =
                  data instanceof Uint8Array ? data : data.subarray();
                return ProtobufMessageChain.decode(buffer);
              },
            },
            { signal }
          );

          decodedMessage = messageData;
        } catch (err: any) {
          if (err.name === "AbortError") {
            this.log(LogLevel.Warning, "Stream reading aborted due to timeout");
          } else {
            this.log(LogLevel.Error, `Failed to read message: ${err.message}`);
          }
          break;
        }

        this.log(LogLevel.Trace, `Received decoded message: ${decodedMessage}`);

        // Преобразуем в MessageChain
        const message = MessageChain.fromProtobuf(root, decodedMessage);

        // Добавляем отправителя
        message.sender = connection;

        // Проверка на дублирование
        const hash = message.getHash();
        if (this.messageHistory.has(hash)) {
          this.log(LogLevel.Info, `Duplicate message ignored: ${hash}`);
          continue;
        }

        // Сохраняем сообщение в историю
        this.messageHistory.set(hash, message);

        // Диспетчеризация события
        this.safeDispatchEvent<MessageChain>("message:receive", {
          detail: message,
        });

        // Рассылка сообщения
        this.broadcastMessage(message);
      }
    } catch (err: any) {
      this.log(
        LogLevel.Error,
        `Failed to handle incoming message: ${err.message}`
      );
    } finally {
      // Закрытие потока
      await stream.close().catch((err) => {
        this.log(LogLevel.Warning, `Failed to close stream: ${err.message}`);
      });
    }
  }

  private async sendMessage(connection: Connection, message: MessageChain) {
    this.log(
      LogLevel.Info,
      `Sending message to ${connection.remotePeer.toString()}: ${message}`
    );
    if (connection == null) {
      throw new Error("connection is null");
    }
    if (connection.status !== "open") {
      throw new Error("connection is not open");
    }

    if (connection.limits) {
      if (connection.limits.seconds && connection.limits.seconds < 10000) {
        throw new OutOfLimitError("connection has time limits");
      }
      if (connection.limits.bytes && connection.limits.bytes < 10000) {
        throw new OutOfLimitError("connection has byte limits");
      }
    }
    const signal = AbortSignal.timeout(this.timeout);
    signal.addEventListener("abort", () => {
      this.log(LogLevel.Warning, "Timeout reached, aborting stream");
      connection.close();
    });

    const stream = await connection.newStream([this.protocol]);
    if (this.proto_root == null) {
      throw new Error("Proto root is not loaded");
    }
    const root = this.proto_root;
    const pbstr = pbStream(stream);
    const msgstr = pbstr.pb(message.toProtobuf(root));
    await msgstr.write({
      type: message.type,
      value: message.value,
    });
  }

  async broadcastMessage(message: MessageChain): Promise<void> {
    this.log(LogLevel.Info, `Broadcasting message: ${JSON.stringify(message)}`);
    const connections = this.components.connectionManager.getConnections();

    for (const connection of connections) {
      try {
        if (connection !== message.sender) {
          await this.sendMessage(connection, message);
        }
      } catch (err) {
        this.log(LogLevel.Error, `Failed to broadcast message: ${err}`);
      }
    }
  }
}