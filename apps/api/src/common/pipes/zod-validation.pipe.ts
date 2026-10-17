import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from "@nestjs/common";
import type { ZodType } from "zod";

/**
 * Pipe de validacion basado en esquemas Zod compartidos.
 *
 * Se usa por parametro: `@Body(new ZodValidationPipe(loginSchema)) dto: LoginInput`
 * De esta forma la API, el panel web y la app movil validan exactamente igual.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: "ValidationError",
        message: "Los datos enviados no son validos",
        details: result.error.issues.map((issue) => ({
          field: issue.path.join(".") || "(raiz)",
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
