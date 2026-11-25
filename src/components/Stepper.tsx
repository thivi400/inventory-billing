import { useApp } from '../context/AppContext';

export function Stepper({ step }: { step: number }) {
  const { lang } = useApp();
  const steps = [
    { num: 1, en: 'Customer', ta: 'வாடிக்கையாளர்' },
    { num: 2, en: 'Items', ta: 'பொருட்கள்' },
    { num: 3, en: 'Pay & Save', ta: 'பணம் & சேமி' },
  ];

  return (
    <div className="stepper" role="navigation" aria-label="Invoice steps">
      {steps.map((s) => {
        const cls = step === s.num ? 'active' : step > s.num ? 'done' : '';
        return (
          <div key={s.num} className={cls}>
            <span>{step > s.num ? '✓' : s.num}</span>
            <b>{lang === 'ta' ? s.ta : s.en}</b>
          </div>
        );
      })}
    </div>
  );
}
