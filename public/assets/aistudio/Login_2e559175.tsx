import { useState } from "react";
import { useApp } from "../context/AppContext";
import { api } from "../services/api";
import type { IconName, Role } from "../types";
import en from "../locales/en.json";
import ta from "../locales/ta.json";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import { LanguageButton } from "../components/LanguageButton";

export function Login({ onLogin }: { onLogin: (token: string, role: Role, name: string) => void }) {
  const { t, speak, voice, setVoice } = useApp();
  const [role, setRole] = useState<Role>("owner");
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const roles: { id: Role; icon: IconName; color: string }[] = [
    { id: "owner", icon: "crown", color: "purple" },
    { id: "manager", icon: "box", color: "blue" },
    { id: "employee", icon: "hand", color: "orange" },
  ];

  const submit = async () => {
    if (pin.length < 4) return;
    setLoading(true);
    setError("");
    try {
      const result = await api.signIn(pin, role);
      sessionStorage.setItem("access_token", result.access_token);
      speak("Signed in", "உள்நுழைந்துவிட்டீர்கள்");
      onLogin(
        result.access_token,
        (result.user?.role as Role) || role,
        result.user?.name || t(role),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("tryAgain"));
      speak("Sign in failed. Please try again", "உள்நுழைய முடியவில்லை. மீண்டும் முயற்சிக்கவும்");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <header className="login-header">
        <Logo />
        <div className="header-tools">
          <LanguageButton />
          <button
            className={`utility-btn ${voice ? "active" : ""}`}
            onClick={() => setVoice(!voice)}
          >
            <Icon name="speaker" size={20} />
            <b>{voice ? t("on") : t("off")}</b>
          </button>
        </div>
      </header>
      <section className="login-card">
        <div className="login-intro">
          <p className="eyebrow">{t("hello")}</p>
          <h1>{t("chooseRole")}</h1>
        </div>
        <div className="role-grid">
          {roles.map((item) => (
            <button
              key={item.id}
              className={`role-card ${item.color} ${role === item.id ? "selected" : ""}`}
              onClick={() => {
                setRole(item.id);
                speak(en[item.id], ta[item.id]);
              }}
            >
              <span>
                <Icon name={item.icon} size={36} />
              </span>
              <b>{t(item.id)}</b>
              {role === item.id && (
                <i>
                  <Icon name="check" size={16} />
                </i>
              )}
            </button>
          ))}
        </div>
        <div className="pin-area">
          <div className="pin-title">
            <div>
              <p className="eyebrow">{t("enterPin")}</p>
              <h2>{t(role)}</h2>
            </div>
            <span>{t("pinHint")}</span>
          </div>
          <div className="pin-dots" aria-label={`${pin.length} digits entered`}>
            {Array.from({ length: 6 }, (_, i) => (
              <i key={i} className={i < pin.length ? "filled" : ""} />
            ))}
          </div>
          <div className="keypad">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
              <button key={n} onClick={() => pin.length < 8 && setPin(pin + n)}>
                {n}
              </button>
            ))}
            <button className="key-action" onClick={() => setPin("")}>
              {t("clear")}
            </button>
            <button onClick={() => pin.length < 8 && setPin(pin + "0")}>0</button>
            <button
              className="key-action"
              aria-label={t("delete")}
              onClick={() => setPin(pin.slice(0, -1))}
            >
              ⌫
            </button>
          </div>
          {error && (
            <div className="error-box">
              <Icon name="warning" size={22} />
              <span>
                {error}
                <small>{t("demoHint")}</small>
              </span>
            </div>
          )}
          <button className="primary-action" disabled={pin.length < 4 || loading} onClick={submit}>
            <Icon name="check" size={28} />
            {loading ? "..." : t("signIn")}
          </button>
        </div>
      </section>
      <footer className="login-footer">
        <span>Fast, safe & simple</span>
        <span className="status-dot">Shop server</span>
      </footer>
    </main>
  );
}
