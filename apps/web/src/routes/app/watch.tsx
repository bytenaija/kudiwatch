import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { getClaim, type ClaimResponse } from '../../lib/api';
import { WatchPlayerView } from '../../components/WatchPlayer';
import { MockBanner, OfflineBar, TopBar, useRequireAuth } from '../../components/ui';

export const Route = createFileRoute('/app/watch')({
  validateSearch: (search: Record<string, unknown>) => ({
    sid: typeof search.sid === 'string' ? search.sid : '',
  }),
  component: WatchPage,
});

function WatchPage() {
  const navigate = useNavigate();
  const { sid } = Route.useSearch();
  const { me, error } = useRequireAuth();
  const [claim, setClaimState] = useState<ClaimResponse | null | undefined>(undefined);

  useEffect(() => {
    setClaimState(getClaim());
  }, []);

  useEffect(() => {
    if (claim === null || !sid) navigate({ to: '/app' });
  }, [claim, sid, navigate]);

  if (error) {
    return (
      <div className="wrap">
        <div className="banner err">{error}</div>
      </div>
    );
  }
  if (!me || claim === undefined || !claim) {
    return (
      <div className="wrap">
        <p className="small">Loading…</p>
      </div>
    );
  }

  return (
    <div className="wrap">
      <TopBar title="Watch" />
      <MockBanner />
      <OfflineBar />
      <WatchPlayerView claim={claim} sessionId={sid} />
    </div>
  );
}
