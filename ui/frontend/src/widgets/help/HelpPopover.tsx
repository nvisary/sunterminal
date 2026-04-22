import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HELP } from './content';

interface Props {
  widgetType: string;
}

export function HelpPopover({ widgetType }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const content = HELP[widgetType];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const handleToggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const panelW = 380;
      const left = Math.max(8, Math.min(window.innerWidth - panelW - 8, r.right - panelW));
      setPos({ top: r.bottom + 4, left });
    }
    setOpen((v) => !v);
  };

  if (!content) {
    return null;
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={handleToggle}
        onMouseDown={(e) => e.stopPropagation()}
        className={`text-[10px] px-1 rounded leading-none ${
          open ? 'text-cyan-300 bg-[#1e1e2e]' : 'text-gray-700 hover:text-cyan-400'
        }`}
        title="How to use this widget"
        aria-label="Help"
      >?</button>
      {open && pos && createPortal(
        <div
          ref={panelRef}
          style={{ top: pos.top, left: pos.left, width: 380 }}
          className="fixed z-[1000] bg-[#0d0d18] border border-[#2a2a3a] rounded-lg shadow-2xl max-h-[70vh] overflow-y-auto"
          onMouseDown={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="sticky top-0 flex items-center justify-between px-3 py-2 bg-[#12121e] border-b border-[#2a2a3a]">
            <span className="text-[12px] font-bold text-cyan-300">{content.title}</span>
            <button
              onClick={() => setOpen(false)}
              className="text-gray-600 hover:text-gray-300 text-[11px]"
            >×</button>
          </div>
          <div className="p-3 space-y-3 text-[11px] text-gray-300 leading-relaxed">
            <p>{content.intro}</p>

            {content.howToRead && (
              <Section title="Как читать">
                {content.howToRead.map((s, i) => (
                  <Item key={i} label={s.label} text={s.text} />
                ))}
              </Section>
            )}

            {content.patterns && (
              <Section title="Паттерны">
                {content.patterns.map((s, i) => (
                  <Item key={i} label={s.label} text={s.text} accent="cyan" />
                ))}
              </Section>
            )}

            {content.example && (
              <Section title="Пример использования">
                <div className="bg-[#0a0a14] border border-[#1a1a2a] rounded p-2 text-[10.5px] text-gray-400 italic">
                  {content.example}
                </div>
              </Section>
            )}

            {content.tips && content.tips.length > 0 && (
              <Section title="Советы">
                <ul className="space-y-1 list-none pl-0">
                  {content.tips.map((t, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-gray-600">→</span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-1">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Item({ label, text, accent }: { label: string; text: string; accent?: 'cyan' }) {
  return (
    <div>
      <span className={`font-semibold ${accent === 'cyan' ? 'text-cyan-300' : 'text-gray-200'}`}>
        {label}
      </span>
      <span className="text-gray-400"> — {text}</span>
    </div>
  );
}
