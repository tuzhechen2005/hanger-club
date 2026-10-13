import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { rig } from './motion/rig'
import './styles.css'

if (import.meta.env.DEV) Object.assign(window, { __rig: rig })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
