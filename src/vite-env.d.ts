/// <reference types="vite/client" />

import type { HTMLAttributes } from 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'wa-icon': HTMLAttributes<HTMLElement> & { name: string }
    }
  }
}
