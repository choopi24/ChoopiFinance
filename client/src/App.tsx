import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { SkeletonCard } from "./components/SkeletonShimmer";
import { ConnectionBanner } from "./components/ConnectionBanner";
import LoginPage from "./pages/auth/LoginPage";

const Dashboard          = lazy(() => import("./pages/Dashboard"));
const InvestmentsPage    = lazy(() => import("./pages/Investments"));
const TransactionsPage   = lazy(() => import("./pages/Transactions"));
const RealizedGainsPage  = lazy(() => import("./pages/RealizedGains"));
const SettingsPage       = lazy(() => import("./pages/Settings"));
const ComponentsPage     = lazy(() => import("./pages/dev/Components"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
});

function PageLoader() {
  return (
    <div style={{ padding: 32, display: "flex", flexDirection: "column", gap: 16, maxWidth: 800, margin: "0 auto" }}>
      <SkeletonCard lines={4} />
      <SkeletonCard lines={3} />
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RedirectIfAuthed({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <PageLoader />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public */}
      <Route
        path="/login"
        element={
          <RedirectIfAuthed>
            <LoginPage />
          </RedirectIfAuthed>
        }
      />

      {/* Protected */}
      <Route
        path="/dashboard"
        element={
          <RequireAuth>
            <Suspense fallback={<PageLoader />}>
              <Dashboard />
            </Suspense>
          </RequireAuth>
        }
      />

      <Route
        path="/investments"
        element={
          <RequireAuth>
            <Suspense fallback={<PageLoader />}>
              <InvestmentsPage />
            </Suspense>
          </RequireAuth>
        }
      />

      <Route
        path="/transactions"
        element={
          <RequireAuth>
            <Suspense fallback={<PageLoader />}>
              <TransactionsPage />
            </Suspense>
          </RequireAuth>
        }
      />

      <Route
        path="/realized"
        element={
          <RequireAuth>
            <Suspense fallback={<PageLoader />}>
              <RealizedGainsPage />
            </Suspense>
          </RequireAuth>
        }
      />

      <Route
        path="/settings"
        element={
          <RequireAuth>
            <Suspense fallback={<PageLoader />}>
              <SettingsPage />
            </Suspense>
          </RequireAuth>
        }
      />

      {/* Dev preview — no auth required */}
      <Route
        path="/dev/components"
        element={
          <Suspense fallback={<PageLoader />}>
            <ComponentsPage />
          </Suspense>
        }
      />

      {/* Default redirects */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectionBanner />
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
