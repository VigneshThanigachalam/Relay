import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { request, message } from './api';
import { Icon } from './Icon';
import { useNotify } from './feedback';
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
  description,
  submitLabel,
  children,
  submit,
  done,
}: {
  title: string;
  description: string;
  submitLabel: string;
  children: ReactNode;
  submit: (data: FormData) => Promise<{ title: string; description: string }>;
  done: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false);
  const running = useRef(false);
  const notify = useNotify();
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running.current) return;
    running.current = true;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const notice = await submit(data);
      setDirty(false);
      notify({ ...notice, type: 'success' });
      done();
    } catch (e) {
      const description = message(e);
      setError(description);
      notify({ type: 'error', title: 'Changes could not be saved', description });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      aria-label={title}
      aria-busy={busy}
      onChange={() => setDirty(true)}
      onSubmit={(e) => void onSubmit(e)}
      className="form-panel"
    >
      <div className="form-heading">
        <span className="section-kicker">OPERATIONS</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <fieldset disabled={busy}>
        {children}
        <div className="form-footer">
          <span>
            {busy
              ? 'Please wait while your changes are recorded…'
              : dirty
                ? 'You have unsaved changes'
                : 'Changes are validated before saving'}
          </span>
          <button className="primary" type="submit">
            {busy ? <Icon name="loader" className="spin" /> : <Icon name="check" />}
            {busy ? 'Saving…' : submitLabel}
          </button>
        </div>
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
      description="Add the delivery details. You can review riders before assigning."
      submitLabel="Create job"
      done={done}
      submit={async (data) => {
        const deadline = str(data, 'deadlineAt');
        const result = await request<{ data: Job; replayed: boolean }>('/jobs', {
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
        return {
          title: result.replayed ? 'Job already exists' : 'Delivery job created',
          description: `${result.data.orderReference} · ${result.replayed ? 'Opened the existing delivery.' : 'Ready for your dispatch review.'}`,
        };
      }}
    >
      <div className="form-callout">
        <Icon name="shield" />
        <p>
          Duplicate-safe by design. Repeated references with identical details open the existing
          delivery.
        </p>
      </div>
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
      description="Keep availability, coverage and capacity accurate for dispatch."
      submitLabel={rider ? 'Save changes' : 'Add rider'}
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
        return {
          title: rider ? 'Rider details saved' : 'Rider added',
          description: `${str(data, 'name')} · Availability, coverage and capacity are up to date.`,
        };
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
      <p className="field-caption">Service zones</p>
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
