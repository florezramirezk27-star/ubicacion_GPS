import Link from "next/link";

export default function HomePage() {
  return (
    <main className="hero">
      <div className="hero-card">
        <div className="row" style={{ marginBottom: "0.75rem" }}>
          <span className="topbar-dot" />
          <strong>Geolocalizador Movil</strong>
        </div>
        <h1>Seguimiento de ubicacion con autorizacion explicita</h1>
        <p className="muted">
          El panel muestra, en tiempo real, la posicion de dispositivos que han
          autorizado compartir su ubicacion desde la aplicacion movil.
        </p>
        <ul className="hero-list">
          <li>El marcador se mueve solo cuando llegan coordenadas nuevas.</li>
          <li>
            El estado distingue ubicacion actual, dato antiguo y dispositivo
            desconectado.
          </li>
          <li>El historial solo es visible para el propietario autorizado.</li>
          <li>
            La ubicacion <strong>no</strong> se obtiene a partir de un numero
            telefonico: requiere consentimiento del dispositivo.
          </li>
        </ul>
        <div className="row">
          <Link className="badge badge-current" href="/login">
            Entrar al panel
          </Link>
          <Link className="badge badge-unknown" href="/dashboard">
            Ir al tablero
          </Link>
        </div>
        <p className="small muted" style={{ marginTop: "1.5rem" }}>
          Documentacion legal: Ley 1581 de 2012 (Colombia) y guias de la SIC
          sobre tratamiento de datos de geolocalizacion. Ver{" "}
          <code>docs/privacidad.md</code>.
        </p>
      </div>
    </main>
  );
}
