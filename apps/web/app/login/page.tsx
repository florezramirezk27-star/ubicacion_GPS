"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { useAuth } from "@/lib/auth-provider";

export default function LoginPage() {
  const router = useRouter();
  const { user, ready } = useAuth();

  useEffect(() => {
    if (ready && user) {
      router.replace(user.role === "SUPERADMIN" ? "/admin" : "/dashboard");
    }
  }, [ready, user, router]);

  return <LoginForm />;
}
