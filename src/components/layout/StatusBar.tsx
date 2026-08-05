import { useSystemStore } from '../../stores';
import { useEffect, useRef, useState } from 'react';

export default function StatusBar() {
  const events = useSystemStore((s) => s.events);
  const [time, setTime] = useState(new Date().toISOString());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(() => setTime(new Date().toISOString()), 1000);
    return () => clearInterval(id);
  }, []);

  const latestEvent = events[0];

  return (
    <footer className="h-7 bg-background border-t border-border flex items-center px-4 text-[11px] text-muted shrink-0 gap-4 overflow-hidden">
      <span className="shrink-0 tabular-nums">{time}</span>
      <div className="h-3 w-px bg-border shrink-0" />
      <div ref={scrollRef} className="overflow-hidden flex-1 whitespace-nowrap">
        {latestEvent && (
          <span className="animate-marquee inline-block">
            [{latestEvent.category}] {latestEvent.stream}.{latestEvent.type} — seq:{latestEvent.sequence} — src:{latestEvent.source}
          </span>
        )}
      </div>
      <div className="h-3 w-px bg-border shrink-0" />
      <span className="shrink-0">v1.0.0</span>
    </footer>
  );
}
