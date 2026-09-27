import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Map as MapIcon, Network, PackagePlus, ShieldAlert } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@vayusetu/ui-components';
import { useTranslation } from 'react-i18next';
import type { ResourceType } from '@vayusetu/shared-types';
import { RESOURCE_TYPE_LABEL } from '@vayusetu/ui-components';
import { useAuth } from '../hooks/useAuth';
import { federationApi, resourcesApi } from '../lib/apiClient';
import { corridorView, DEFAULT_CORRIDORS } from '../lib/corridors';
import type { HexDatum } from '../lib/hexGeo';
import { HexMap } from '../components/HexMap';

const RESOURCE_TYPES: ResourceType[] = [
  'inspection_team',
  'anti_smog_gun',
  'water_sprinkler',
  'mobile_monitoring_van',
  'public_advisory',
  'other',
];

export function FederationPanel() {
  const { t } = useTranslation();
  const { getToken, session } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();

  const { data: modelsData } = useQuery({
    queryKey: ['federation-models'],
    queryFn: async () => federationApi.models(await getToken()),
  });

  const { data: resourceData } = useQuery({
    queryKey: ['resource-requests'],
    queryFn: async () => resourcesApi.list(await getToken(), { pageSize: 50 }),
  });

  const canImport = session?.role === 'super_admin';
  const importModel = useMutation({
    mutationFn: async (modelId: string) => federationApi.importModel(await getToken(), modelId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['federation-models'] });
      push({ tone: 'success', title: t('federation.imported') });
    },
    onError: (error: unknown) =>
      push({
        tone: 'error',
        title: t('federation.importBlocked'),
        description: error instanceof Error ? error.message : 'super_admin required — the highest-blast-radius action in the system.',
      }),
  });

  const [resourceType, setResourceType] = React.useState<ResourceType>('inspection_team');
  const [quantity, setQuantity] = React.useState('1');

  const createRequest = useMutation({
    mutationFn: async () => resourcesApi.create(await getToken(), { resourceType, quantityNeeded: Number(quantity) || 1 }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['resource-requests'] });
      push({ tone: 'success', title: t('federation.posted') });
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-ink">{t('federation.title')}</h1>
        <p className="text-sm text-slate-500">{t('federation.subtitle')}</p>
      </div>

      <Tabs defaultValue="models">
        <TabsList>
          <TabsTrigger value="models">{t('federation.tabModels')}</TabsTrigger>
          <TabsTrigger value="exchange">{t('federation.tabExchange')}</TabsTrigger>
          <TabsTrigger value="resources">{t('federation.tabResources')}</TabsTrigger>
        </TabsList>

        <TabsContent value="models">
          {modelsData?.currentlyActive && (
            <Card className="mb-3 border-emerald-200 bg-emerald-50/50">
              <CardContent className="flex items-center gap-2 py-3 text-sm">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                {t('federation.active')} <span className="font-semibold">{modelsData.currentlyActive.sourceStateCode} · {modelsData.currentlyActive.modelType} v{modelsData.currentlyActive.version}</span>
              </CardContent>
            </Card>
          )}
          {!modelsData?.available.length ? (
            <EmptyState icon={Network} title={t('federation.noModels')} description={t('federation.noModelsHint')} />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {modelsData.available.map((model) => (
                <Card key={model.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">
                        {model.sourceStateCode} · {model.modelType} v{model.version}
                      </CardTitle>
                      {session?.role !== 'super_admin' && <ShieldAlert className="h-4 w-4 text-slate-300" aria-hidden="true" />}
                    </div>
                    <CardDescription>
                      {t('federation.records', { count: model.trainingDataSummary.recordCount, date: new Date(model.sharedAt).toLocaleDateString() })}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-slate-500">
                      {Object.entries(model.performanceMetrics).map(([k, v]) => (
                        <span key={k} className="rounded bg-slate-100 px-1.5 py-0.5">
                          {k}: {v}
                        </span>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canImport}
                      title={canImport ? undefined : t('federation.importSuperOnly')}
                      onClick={() => importModel.mutate(model.id)}
                      loading={importModel.isPending && importModel.variables === model.id}
                    >
                      <Download className="h-3.5 w-3.5" /> {t('federation.import')}
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="exchange">
          <CrossStateView />
        </TabsContent>

        <TabsContent value="resources">
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="text-sm">{t('federation.postRequest')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>{t('federation.resourceType')}</Label>
                <Select value={resourceType} onValueChange={(v) => setResourceType(v as ResourceType)}>
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOURCE_TYPES.map((rt) => (
                      <SelectItem key={rt} value={rt}>
                        {RESOURCE_TYPE_LABEL[rt]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('federation.quantity')}</Label>
                <Input type="number" min={1} className="w-24" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <Button onClick={() => createRequest.mutate()} loading={createRequest.isPending}>
                <PackagePlus className="h-4 w-4" /> {t('federation.post')}
              </Button>
            </CardContent>
          </Card>

          <ul className="flex flex-col gap-2">
            {(resourceData?.items ?? []).map((req) => (
              <li key={req.id}>
                <Card className="flex items-center justify-between p-4">
                  <div>
                    <p className="text-sm font-medium text-ink">
                      {req.quantityNeeded}× {RESOURCE_TYPE_LABEL[req.resourceType]}
                    </p>
                    <p className="text-xs text-slate-400">
                      {req.jurisdiction.districtCode ?? req.jurisdiction.stateCode} · {new Date(req.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <span className="text-xs font-semibold capitalize text-slate-500">{req.status}</span>
                </Card>
              </li>
            ))}
          </ul>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** PRODUCT_SPEC Feature 4: corridors that span state lines (NCR = DL, HR, UP,
 *  RJ) get one aggregated view -- built only from what each state published
 *  to the Exchange (res-6, weekly, k-anonymized), never another state's grid. */
function CrossStateView() {
  const { t } = useTranslation();
  const { getToken } = useAuth();
  const [corridorId, setCorridorId] = React.useState('ncr-airshed');
  const view = corridorView(corridorId);
  const { data, isLoading } = useQuery({
    queryKey: ['federation-summary', corridorId],
    queryFn: async () => federationApi.hotspotSummary(await getToken(), view.bbox),
  });
  const rows = data?.summary ?? [];
  const latestWeek = rows.reduce((w, r) => (r.weekStartDate > w ? r.weekStartDate : w), '');
  const latest = rows.filter((r) => r.weekStartDate === latestWeek);
  const hexes = React.useMemo<HexDatum[]>(
    () =>
      latest.map((r) => ({
        h3Index: r.h3IndexGeneralized,
        score: r.avgHotspotConfidence,
        label: `${r.sourceStateCode} · ${Math.round(r.avgHotspotConfidence * 100)}% avg confidence`,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, latestWeek],
  );
  const byState = Object.entries(
    latest.reduce<Record<string, number[]>>((acc, r) => ({ ...acc, [r.sourceStateCode]: [...(acc[r.sourceStateCode] ?? []), r.avgHotspotConfidence] }), {}),
  ).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {latestWeek ? t('federation.weekSummary', { week: latestWeek, cells: latest.length, states: byState.length }) : t('federation.exchangeIntro')}
        </p>
        <Select value={corridorId} onValueChange={setCorridorId}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEFAULT_CORRIDORS.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {t(`corridor.${c.id}`, { defaultValue: c.name })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isLoading ? null : latest.length === 0 ? (
        <EmptyState icon={MapIcon} title={t('federation.noSummaries')} description={t('federation.noSummariesHint')} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-[1fr_16rem]">
          <div className="overflow-hidden rounded-xl2 border border-slate-200 bg-white">
            <HexMap cells={hexes} center={view.center} zoom={8} height="26rem" mapKey={`x-${corridorId}`} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t('federation.byState')}</CardTitle>
              <CardDescription>{t('federation.byStateHint')}</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-sm">
                {byState.map(([state, scores]) => (
                  <li key={state} className="flex justify-between">
                    <span className="font-medium text-ink">{state}</span>
                    <span className="text-slate-500">
                      {t('federation.stateCells', { count: scores.length, pct: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) })}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
