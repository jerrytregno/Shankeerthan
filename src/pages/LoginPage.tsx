import { useNavigate } from "react-router-dom";
import { FormEvent, useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { FirebaseError } from "firebase/app";
import { useAuth } from "@/contexts/auth-context";

type Mode = "signIn" | "signUp";

function authErrorMessage(err: unknown, mode: Mode): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return "Incorrect email or password.";
      case "auth/email-already-in-use":
        return "An account with this email already exists. Sign in instead.";
      case "auth/weak-password":
        return "Password must be at least 6 characters.";
      case "auth/invalid-email":
        return "Enter a valid email address.";
      case "auth/operation-not-allowed":
        return "Email/password sign-in is not enabled in Firebase Authentication.";
      case "auth/too-many-requests":
        return "Too many attempts. Try again in a few minutes.";
    }
  }
  if (err instanceof Error) return err.message;
  return mode === "signUp" ? "Sign up failed" : "Sign in failed";
}

export default function LoginPage() {
  const { user, loading, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("signIn");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isSignUp = mode === "signUp";

  useEffect(() => {
    if (!loading && user) navigate("/dashboard/nine-fifteen", { replace: true });
  }, [user, loading, navigate]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setConfirmPassword("");
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (isSignUp && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      if (isSignUp) await signUp(email, password);
      else await signIn(email, password);
      navigate("/dashboard/nine-fifteen");
    } catch (err) {
      setError(authErrorMessage(err, mode));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || user) {
    return (
      <div className="flex-center" style={{ minHeight: "100vh" }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">
          <div className="logo" style={{ justifyContent: "center" }}>
            <div className="logo-icon">
              <Zap size={20} />
            </div>
            <span className="logo-text">9:15 Trader</span>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{isSignUp ? "Create account" : "Sign in"}</h2>
            <p className="card-desc">
              {isSignUp
                ? "Sign up with email and password to get started"
                : "View 9:15 candles and bot status"}
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label className="label">Email</label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>
            <div className="field">
              <label className="label">Password</label>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                minLength={isSignUp ? 6 : undefined}
                autoComplete={isSignUp ? "new-password" : "current-password"}
              />
            </div>
            {isSignUp && (
              <div className="field">
                <label className="label">Confirm password</label>
                <input
                  className="input"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </div>
            )}
            {error && <div className="alert alert-error">{error}</div>}
            <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
              {submitting ? "Please wait..." : isSignUp ? "Create account" : "Sign in"}
            </button>
          </form>

          <p className="card-desc" style={{ textAlign: "center", marginTop: "1rem" }}>
            {isSignUp ? "Already have an account?" : "New here?"}{" "}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => switchMode(isSignUp ? "signIn" : "signUp")}
              disabled={submitting}
            >
              {isSignUp ? "Sign in" : "Create an account"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
