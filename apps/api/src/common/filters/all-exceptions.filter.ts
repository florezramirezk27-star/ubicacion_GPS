import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";

/**
 * Filtro global de excepciones: devuelve una forma de error uniforme
 * y evita filtrar detalles internos (stack traces) al cliente.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("ExceptionFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== "http") {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
      );
      return;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: Record<string, unknown> = {
      statusCode: status,
      error: "InternalServerError",
      message: "Ocurrio un error inesperado en el servidor",
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const responseBody = exception.getResponse();
      if (typeof responseBody === "string") {
        body = {
          statusCode: status,
          error: exception.name,
          message: responseBody,
        };
      } else {
        body = {
          statusCode: status,
          ...(responseBody as Record<string, unknown>),
        };
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `${request.method} ${request.url} -> ${exception.message}`,
        exception.stack,
      );
    }

    response.status(status).json({
      ...body,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
