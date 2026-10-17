import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService, type JwtSignOptions } from "@nestjs/jwt";
import type {
  AccessTokenPayload,
  AuthResponse,
  LoginInput,
  PublicUser,
  RegisterInput,
} from "@geo/shared";
import { AuditService } from "../audit/audit.service";
import { parseEmailList, parseDurationToMs } from "../config/env";
import { CryptoService } from "../crypto/crypto.service";
import { PrismaService } from "../prisma/prisma.service";
import { UsersService, type UserRecord } from "../users/users.service";
import { PasswordService } from "./password.service";

type ExpiresIn = NonNullable<JwtSignOptions["expiresIn"]>;

const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async register(
    input: RegisterInput,
    ip: string | null,
  ): Promise<AuthResponse> {
    const existing = await this.users.findByEmail(input.email);
    if (existing) {
      throw new ConflictException("El correo electronico ya esta registrado");
    }

    const passwordHash = await this.passwords.hash(input.password);

    let user: UserRecord;
    try {
      user = await this.users.create(input.email, passwordHash);
    } catch (error) {
      // Condicion de carrera: dos registros simultaneos con el mismo correo.
      if (isUniqueViolation(error)) {
        throw new ConflictException("El correo electronico ya esta registrado");
      }
      throw error;
    }

    user = await this.applySuperadminPolicy(user);

    await this.audit.record({
      actorId: user.id,
      action: "auth.register",
      metadata: { email: user.email },
      ip,
    });

    return this.issueSession(user, null);
  }

  async login(
    input: LoginInput,
    userAgent: string | null,
    ip: string | null,
  ): Promise<AuthResponse> {
    let user = await this.users.findByEmail(input.email);
    if (!user) {
      await this.audit.record({
        action: "auth.login_failed",
        metadata: { email: input.email, reason: "usuario_no_existe" },
        ip,
      });
      throw new UnauthorizedException("Credenciales invalidas");
    }

    const passwordOk = await this.passwords.verify(
      input.password,
      user.passwordHash,
    );
    if (!passwordOk) {
      await this.audit.record({
        actorId: user.id,
        action: "auth.login_failed",
        metadata: { email: user.email, reason: "contrasena_incorrecta" },
        ip,
      });
      throw new UnauthorizedException("Credenciales invalidas");
    }

    user = await this.applySuperadminPolicy(user);

    await this.audit.record({
      actorId: user.id,
      action: "auth.login",
      metadata: { userAgent },
      ip,
    });

    return this.issueSession(user, userAgent);
  }

  /**
   * Rotacion de tokens: el refresh token es opaco y de un solo uso.
   * Al usarlo se revoca la sesion anterior y se emite una nueva.
   */
  async refresh(refreshToken: string): Promise<AuthResponse> {
    const refreshHash = this.crypto.sha256(refreshToken);
    const session = await this.prisma.session.findUnique({
      where: { refreshHash },
      include: { user: true },
    });

    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException("Sesion invalida o expirada");
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    return this.issueSession(
      {
        id: session.user.id,
        email: session.user.email,
        role: session.user.role,
        createdAt: session.user.createdAt,
      },
      session.userAgent,
    );
  }

  async logout(refreshToken: string): Promise<{ success: true }> {
    const refreshHash = this.crypto.sha256(refreshToken);
    await this.prisma.session.updateMany({
      where: { refreshHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException("Usuario no encontrado");
    return this.users.toPublic(user);
  }

  /** Revoca todas las sesiones activas de un usuario (cierre global). */
  async revokeAllSessions(userId: string): Promise<{ revoked: number }> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count };
  }

  /**
   * Promociona a SUPERADMIN si el correo figura en `SUPERADMIN_EMAILS`.
   *
   * Es una lista de confianza del operador (variable de entorno), no algo que
   * el usuario pueda activar por si mismo. Se aplica en cada inicio de sesion
   * para que un cambio de configuracion surta efecto sin tocar la base de datos.
   */
  private async applySuperadminPolicy(user: UserRecord): Promise<UserRecord> {
    if (user.role === "SUPERADMIN") return user;

    const allowed = parseEmailList(
      this.config.get<string>("SUPERADMIN_EMAILS") ?? "",
    );
    if (!allowed.includes(user.email.toLowerCase())) return user;

    const updated = await this.users.setRoleByEmail(user.email, "SUPERADMIN");
    return updated ?? user;
  }

  private async issueSession(
    user: Pick<UserRecord, "id" | "email" | "role" | "createdAt">,
    userAgent: string | null,
  ): Promise<AuthResponse> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      type: "access",
    };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"),
      expiresIn: this.config.getOrThrow<string>("JWT_ACCESS_TTL") as ExpiresIn,
    });

    const refreshToken = this.crypto.randomToken(48);
    const refreshTtlMs = parseDurationToMs(
      this.config.getOrThrow<string>("JWT_REFRESH_TTL"),
      DEFAULT_REFRESH_TTL_MS,
    );

    await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshHash: this.crypto.sha256(refreshToken),
        userAgent,
        expiresAt: new Date(Date.now() + refreshTtlMs),
      },
    });

    return {
      accessToken,
      refreshToken,
      user: this.users.toPublic(user),
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
