import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest, AuthenticatedShare } from "../types";

/** Inyecta la sesion de comparticion resuelta por el ShareTokenGuard. */
export const CurrentShare = createParamDecorator(
  (
    _data: unknown,
    context: ExecutionContext,
  ): AuthenticatedShare | undefined => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.share;
  },
);
