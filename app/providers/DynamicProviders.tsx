'use client';

import dynamic from 'next/dynamic';

const BottomNav = dynamic(() => import('@/components/bottom-nav'), { ssr: false });
const AIAssistantProvider = dynamic(() => import('@/app/providers/AIAssistantProvider'), {
  ssr: false,
});
const PerformanceMonitor = dynamic(() => import('@/components/PerformanceMonitor'), { ssr: false });

export { BottomNav, AIAssistantProvider, PerformanceMonitor };
