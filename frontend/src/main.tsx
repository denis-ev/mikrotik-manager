import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';

// Initialize theme from storage immediately
const storedTheme = (() => {
  try {
    const raw = localStorage.getItem('mikrotik-theme');
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed?.state?.theme;
    }
  } catch {
    // localStorage unavailable (e.g. sandboxed iframe) — leave as default
  }
  return 'light';
})();
if (storedTheme === 'dark') {
  document.documentElement.classList.add('dark');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
