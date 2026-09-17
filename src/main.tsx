import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AsrsSim } from './AsrsSim';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AsrsSim />
  </StrictMode>,
);
