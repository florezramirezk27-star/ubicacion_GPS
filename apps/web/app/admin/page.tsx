"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AdminDashboard } from "@/components/admin-dashboard";
import { useAuth } from "@/lib/auth-provider";

/**
 * Ruta del panel de Superadministrador.
 *
 * El backend exige el rol SUPERADMIN en cada peticion; aqui ademas se evita
 * siquiera montar el panel si la sesion no tiene ese rol, redirigiendo al
 * tablero normal. La autorizacion real, en cualquier caso, vive en el servidor.
 */
export default function AdminPage() {
  const router = useRouter();
  const { user, ready } = useAuth();

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      router.replace("/login");
    } else if (user.role !== "SUPERADMIN") {
      router.replace("/dashboard");
    }
  }, [ready, user, router]);

  if (!ready || !user || user.role !== "SUPERADMIN") {
    return (
      <div className="login-grid">
        <p className="muted">Verificando permisos de administracion...</p>
      </div>
    );
  }

  return <AdminDashboard />;
}
