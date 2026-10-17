import { IoAdapter } from "@nestjs/platform-socket.io";
import type { INestApplicationContext } from "@nestjs/common";

/** Tipos derivados del adaptador base para no acoplarnos a una version concreta. */
type IoServerOptions = Parameters<IoAdapter["createIOServer"]>[1];
type IoServer = ReturnType<IoAdapter["createIOServer"]>;

/**
 * Adaptador de Socket.IO que aplica la misma politica de CORS que la API REST.
 * Sin esto, el panel web no podria abrir el WebSocket desde otro origen.
 */
export class ConfiguredIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly allowedOrigins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: IoServerOptions): IoServer {
    const merged = {
      ...options,
      cors: {
        origin: this.allowedOrigins.length > 0 ? this.allowedOrigins : true,
        credentials: true,
      },
    } as IoServerOptions;

    return super.createIOServer(port, merged);
  }
}
