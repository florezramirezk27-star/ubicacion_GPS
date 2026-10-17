"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { loginSchema, registerSchema } from "@geo/shared";
import { ApiError, getSession } from "@/lib/api";
import { useAuth } from "@/lib/auth-provider";

type Mode = "login" | "register";

export function LoginForm() {
  const router = useRouter();
  const { login, register } = useAuth();

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    // Validacion en cliente reutilizando los esquemas compartidos con el backend.
    const schema = mode === "register" ? registerSchema : loginSchema;
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Datos invalidos");
      return;
    }

    setBusy(true);
    try {
      if (mode === "register") {
        await register(parsed.data.email, parsed.data.password);
      } else {
        await login(parsed.data.email, parsed.data.password);
      }
      // El Superadministrador entra directamente a su panel.
      const role = getSession()?.user.role;
      router.push(role === "SUPERADMIN" ? "/admin" : "/dashboard");
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError(
          "No se pudo conectar con la API. Verifica que el backend este en ejecucion.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-grid">
      <div className="login-card">
        <div className="row" style={{ marginBottom: "0.5rem" }}>
          <span className="topbar-dot" />
          <strong>Geolocalizador Movil</strong>
        </div>
        <h1 style={{ fontSize: "1.3rem" }}>
          {mode === "login" ? "Iniciar sesion" : "Crear cuenta"}
        </h1>
        <p className="muted small" style={{ marginTop: 0 }}>
          Acceso al panel de seguimiento autorizado.
        </p>

        <div className="tabs" role="tablist">
          <button
            type="button"
            className={mode === "login" ? "active" : ""}
            onClick={() => {
              setMode("login");
              setError(null);
            }}
          >
            Iniciar sesion
          </button>
          <button
            type="button"
            className={mode === "register" ? "active" : ""}
            onClick={() => {
              setMode("register");
              setError(null);
            }}
          >
            Registrarme
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="email">Correo electronico</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="tu@correo.com"
              required
            />
          </div>

          <div className="field">
            <label htmlFor="password">Contrasena</label>
            <input
              id="password"
              type="password"
              autoComplete={
                mode === "register" ? "new-password" : "current-password"
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Minimo 8 caracteres"
              required
            />
            {mode === "register" && (
              <p className="small muted" style={{ marginBottom: 0 }}>
                Debe incluir al menos una mayuscula, una minuscula y un numero.
              </p>
            )}
          </div>

          {error && (
            <div
              className="alert alert-error"
              style={{ marginBottom: "0.9rem" }}
            >
              {error}
            </div>
          )}

          <button
            className="primary"
            type="submit"
            disabled={busy}
            style={{ width: "100%" }}
          >
            {busy
              ? "Procesando..."
              : mode === "login"
                ? "Entrar"
                : "Crear cuenta y entrar"}
          </button>
        </form>

        <p className="small muted" style={{ marginTop: "1rem" }}>
          Usuario de demostracion (creado por el seed):{" "}
          <span className="mono">demo@geo.test</span> /{" "}
          <span className="mono">Demo1234</span>
          <br />
          Superadministrador: <span className="mono">
            admin@geo.test
          </span> / <span className="mono">Admin1234</span>
        </p>
      </div>
    </div>
  );
}
