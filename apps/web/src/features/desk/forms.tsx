import { useState, type FormEvent, type ReactNode } from 'react';
import { request, message } from './api';
import { ErrorBox, label } from './shared';
import { zones, type Job, type Rider } from './types';
export function ZoneField({
  name,
  title,
  initial = 'CENTRAL',
}: {
  name: string;
  title: string;
  initial?: string;
}) {
  return (
    <label>
      {title}
      <select name={name} defaultValue={initial}>
        {zones.map((z) => (
          <option key={z}>{z}</option>
        ))}
      </select>
    </label>
  );
}
function MutationForm({
  title,
  children,
  submit,
  done,
}: {
  title: string;
  children: ReactNode;
  submit: (data: FormData) => Promise<void>;
  done: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await submit(data);
      done();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form aria-label={title} onSubmit={(e) => void onSubmit(e)} className="panel form-panel">
      <h2>{title}</h2>
      <fieldset disabled={busy}>
        {children}
        <button className="primary" type="submit">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </fieldset>
      {error && <ErrorBox error={error} />}
    </form>
  );
}
const str = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
export function JobForm({ done, open }: { done: () => void; open: (id: string) => void }) {
  return (
    <MutationForm
      title="Create delivery job"
      done={done}
      submit={async (data) => {
        const deadline = str(data, 'deadlineAt');
        const result = await request<{ data: Job }>('/jobs', {
          method: 'POST',
          body: {
            orderReference: str(data, 'orderReference'),
            pickupZone: str(data, 'pickupZone'),
            deliveryZone: str(data, 'deliveryZone'),
            loadUnits: Number(data.get('loadUnits')),
            priority: str(data, 'priority'),
            ...(deadline ? { deadlineAt: new Date(deadline).toISOString() } : {}),
          },
        });
        open(result.data.id);
      }}
    >
      <p className="muted">Repeated references with the same details return the existing job.</p>
      <label>
        Order reference
        <input name="orderReference" required maxLength={80} placeholder="ORDER-1042" />
      </label>
      <div className="form-grid">
        <ZoneField name="pickupZone" title="Pickup zone" />
        <ZoneField name="deliveryZone" title="Delivery zone" initial="NORTH" />
      </div>
      <div className="form-grid">
        <label>
          Load units
          <input name="loadUnits" type="number" min="1" step="1" required defaultValue="2" />
        </label>
        <label>
          Priority
          <select name="priority" defaultValue="NORMAL">
            {['LOW', 'NORMAL', 'HIGH', 'URGENT'].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Delivery deadline (optional, local time)
        <input name="deadlineAt" type="datetime-local" />
      </label>
    </MutationForm>
  );
}
export function RiderForm({ rider, done }: { rider?: Rider; done: () => void }) {
  return (
    <MutationForm
      key={rider?.id ?? 'new'}
      title={rider ? `Edit ${rider.code}` : 'Create rider'}
      done={done}
      submit={async (data) => {
        await request(rider ? `/riders/${rider.id}` : '/riders', {
          method: rider ? 'PATCH' : 'POST',
          body: {
            ...(!rider ? { code: str(data, 'code') } : {}),
            name: str(data, 'name'),
            serviceZones: data.getAll('serviceZones'),
            currentZone: str(data, 'currentZone'),
            availability: str(data, 'availability'),
            capacityUnits: Number(data.get('capacityUnits')),
          },
        });
      }}
    >
      {!rider && (
        <label>
          Rider code
          <input name="code" required maxLength={40} />
        </label>
      )}
      <label>
        Rider name
        <input name="name" required maxLength={100} defaultValue={rider?.name} />
      </label>
      <div className="form-grid">
        <ZoneField
          name="currentZone"
          title="Current zone"
          initial={rider?.currentZone ?? 'CENTRAL'}
        />
        <label>
          Availability
          <select name="availability" defaultValue={rider?.availability ?? 'AVAILABLE'}>
            <option>AVAILABLE</option>
            <option>UNAVAILABLE</option>
          </select>
        </label>
      </div>
      <label>
        Total capacity units
        <input
          name="capacityUnits"
          required
          type="number"
          min={rider?.reservedUnits || 1}
          step="1"
          defaultValue={rider?.capacityUnits ?? 10}
        />
      </label>
      <p className="muted">
        Reserved capacity is managed by assignments. Active delivery coverage cannot be removed.
      </p>
      <div className="checks" role="group" aria-label="Service zones">
        {zones.map((z) => (
          <label key={z}>
            <input
              type="checkbox"
              name="serviceZones"
              value={z}
              defaultChecked={
                rider ? rider.serviceZones.includes(z) : z === 'CENTRAL' || z === 'NORTH'
              }
            />
            {label(z)}
          </label>
        ))}
      </div>
    </MutationForm>
  );
}
