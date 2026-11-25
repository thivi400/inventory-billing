import { useState, useEffect } from "react";
import { AppProvider } from "./context/AppContext";
import { api } from "./services/api";
import type { Role, Screen } from "./types";
import { Shell } from "./components/Shell";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { Sale } from "./pages/Sale";
import { Stock } from "./pages/Stock";
import { Payments } from "./pages/Payments";
import { Customers } from "./pages/Customers";
import { Reports } from "./pages/Reports";

function AuthenticatedApp({
  token,
  role,
  name,
  logout,
}: {
  token: string;
  role: Role;
  name: string;
  logout: () => void;
}) {
  const [screen, setScreenState] = useState<Screen>("home");

  const setScreen = (newScreen: Screen) => {
    setScreenState(newScreen);
  };

  const goHome = () => {
    setScreen("home");
  };

  return (
    <Shell
      screen={screen}
      setScreen={setScreen}
      role={role}
      name={name}
      onLogout={logout}
      goHome={goHome}
    >
      {screen === "home" ? (
        <Home setScreen={setScreen} token={token} role={role} />
      ) : screen === "sale" ? (
        <Sale token={token} onGoHome={goHome} />
      ) : screen === "stock" ? (
        <Stock token={token} role={role} onGoHome={goHome} />
      ) : screen === "payments" ? (
        <Payments token={token} role={role} onGoHome={goHome} />
      ) : screen === "customers" ? (
        <Customers token={token} role={role} onGoHome={goHome} />
      ) : (
        <Reports role={role} token={token} onGoHome={goHome} />
      )}
    </Shell>
  );
}

function Root() {
  const [session, setSession] = useState<{ token: string; role: Role; name: string } | null>(null);

  // Stop mouse scroll from increasing/decreasing number inputs as requested
  useEffect(() => {
    const handleWheel = () => {
      const active = document.activeElement;
      if (active && (active as HTMLInputElement).type === "number") {
        (active as HTMLInputElement).blur();
      }
    };
    window.addEventListener("wheel", handleWheel, { passive: true });
    return () => window.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const token = sessionStorage.getItem("access_token");
    if (!token) return;
    api
      .get<{ full_name?: string; role?: Role }>("/auth/me", token)
      .then((user) =>
        setSession({ token, role: user.role || "employee", name: user.full_name || "Shop user" }),
      )
      .catch(() => sessionStorage.removeItem("access_token"));
  }, []);

  const logout = async () => {
    if (session) await api.signOut(session.token).catch(() => {});
    sessionStorage.removeItem("access_token");
    setSession(null);
  };

  return session ? (
    <AuthenticatedApp {...session} logout={logout} />
  ) : (
    <Login onLogin={(token, role, name) => setSession({ token, role, name })} />
  );
}

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}
