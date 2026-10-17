"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { useAuth } from "@/lib/auth-provider";

export default function DashboardPage() {
  const router = useRouter();
  const { user, ready } = useAuth();

  useEffect(() => {
    if (ready && !user) {
      router.replace("/login");
    }
  }, [ready, user, router]);

  if (!ready || !user) {
    return (
      <div className="login-grid">
        <p className="muted">Cargando panel...</p>
      </div>
    );
  }

  return <Dashboard />;
}
