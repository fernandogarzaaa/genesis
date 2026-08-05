import type { ReactNode } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import StatusBar from './StatusBar';

interface ShellProps {
  children: ReactNode;
}

export default function Shell({ children }: ShellProps) {
  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <div className="flex flex-1 overflow-hidden bg-dot-grid">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <Header />
          <main className="flex-1 overflow-y-auto p-6">
            {children}
          </main>
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
