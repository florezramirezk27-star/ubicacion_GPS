import { Injectable } from "@nestjs/common";
import type { PublicUser, UserRole } from "@geo/shared";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Representacion minima de un usuario en la capa de persistencia.
 * Se declara localmente para no acoplar los servicios al cliente generado.
 */
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(email: string, passwordHash: string): Promise<UserRecord> {
    return this.prisma.user.create({ data: { email, passwordHash } });
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /**
   * Cambia el rol de un usuario identificado por su correo.
   * Lo usa la politica de SUPERADMIN_EMAILS (lista de confianza del operador).
   */
  async setRoleByEmail(
    email: string,
    role: UserRole,
  ): Promise<UserRecord | null> {
    const user = await this.findByEmail(email);
    if (!user) return null;
    if (user.role === role) return user;
    return this.prisma.user.update({
      where: { id: user.id },
      data: { role },
    });
  }

  count(): Promise<number> {
    return this.prisma.user.count();
  }

  toPublic(
    user: Pick<UserRecord, "id" | "email" | "role" | "createdAt">,
  ): PublicUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
