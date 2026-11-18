import { validateCapture, type Capture } from "../capture.js";
import {
  storedPlanSchema,
  StorageError,
  captureSummary,
  newRunSchema,
  newScanReportSchema,
  sampleSchema,
  type AggregateQuery,
  type CaptureQuery,
  type CaptureSummary,
  type NewRun,
  type NewScanReport,
  type Origin,
  type Run,
  type RunQuery,
  type Sample,
  type SampleQuery,
  type ScanReport,
  type ScanReportQuery,
  type ScanReportSummary,
  type SignalAggregate,
  type Storage,
  type StoredPlan,
  type StoredProfile,
  type CaptureRecord,
} from "../storage.js";
import {
  mergeVehicles,
  orderedRegister,
  recordSighting,
  vehicleRegisterSchema,
  withPlate,
  withVehicle,
  withoutPlate,
  type PlateAssignment,
  type Sighting,
  type Vehicle,
  type VehicleRegister,
} from "../vehicles.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Runs `work` and returns its result as a promise, so a {@link StorageError} thrown inside rejects instead of throwing at the call. */
function settle<T>(work: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(work());
  });
}

function page<T>(items: readonly T[], offset: number | undefined, limit: number | undefined): T[] {
  const start = offset ?? 0;
  return items.slice(start, limit === undefined ? undefined : start + limit);
}

/** The samples of one run, in the order stored, that a query's signal and time range select. */
function inRange(samples: readonly Sample[], query: AggregateQuery): Sample[] {
  return samples.filter(
    (sample) =>
      (query.signal === undefined || sample.signal === query.signal) &&
      (query.from === undefined || sample.timestamp >= query.from) &&
      (query.to === undefined || sample.timestamp < query.to),
  );
}

/**
 * An in-memory {@link Storage} for tests and for sessions that keep nothing: records live in maps and arrays and are copied on the way in and out, so a caller never holds a reference into the store.
 *
 * Passes the same contract suite as the SQLite implementation.
 */
export class MemoryStorage implements Storage {
  private readonly runs = new Map<string, Run>();
  private readonly samples = new Map<string, Sample[]>();
  private readonly reports = new Map<string, ScanReport>();
  private readonly profiles = new Map<string, StoredProfile>();
  /** Kept as text, so a stored plan shares nothing with the caller's objects. */
  private readonly plans = new Map<string, string>();
  private readonly captures = new Map<
    string,
    { readonly text: string; readonly record: CaptureRecord }
  >();
  /** Kept as text, as the plans are. */
  private register = JSON.stringify({ vehicles: [], plates: [] });
  private readonly newId: () => string;

  /**
   * @param newId Produces each new run and report id; defaults to a counter. Ids only need to be unique within this store.
   */
  constructor(newId?: () => string) {
    let next = 0;
    this.newId = newId ?? (() => `id-${String((next += 1))}`);
  }

  createRun(input: NewRun): Promise<Run> {
    return settle(() => {
      const fields = newRunSchema.parse(input);
      const run: Run = { id: this.newId(), ...fields, stoppedAt: null };
      this.runs.set(run.id, run);
      this.samples.set(run.id, []);
      this.sighted(run.origin, { vin: run.vin, plate: run.plate, at: run.startedAt });
      return { ...run };
    });
  }

  getVehicleRegister(): Promise<VehicleRegister> {
    return settle(() => this.readRegister());
  }

  saveVehicle(vehicle: Vehicle): Promise<VehicleRegister> {
    return this.changeRegister((register) => withVehicle(register, vehicle));
  }

  savePlateAssignment(assignment: PlateAssignment): Promise<VehicleRegister> {
    return this.changeRegister((register) => withPlate(register, assignment));
  }

  deletePlateAssignment(id: string): Promise<VehicleRegister> {
    return this.changeRegister((register) => withoutPlate(register, id));
  }

  mergeVehicles(keepId: string, removeId: string): Promise<VehicleRegister> {
    return this.changeRegister((register) => mergeVehicles(register, keepId, removeId));
  }

  recordSighting(sighting: Sighting): Promise<string | undefined> {
    return settle(() => this.sight(sighting));
  }

  /** Records a sighting of a record this device read itself; one saved from a link or a file says nothing about the user's own cars. */
  private sighted(origin: Origin, sighting: Sighting): void {
    if (origin === "local") this.sight(sighting);
  }

  private sight(sighting: Sighting): string | undefined {
    const { vehicleId, register } = recordSighting(this.readRegister(), sighting, this.newId);
    this.register = JSON.stringify(register);
    return vehicleId;
  }

  private changeRegister(
    change: (register: VehicleRegister) => VehicleRegister,
  ): Promise<VehicleRegister> {
    return settle(() => {
      const after = change(this.readRegister());
      this.register = JSON.stringify(after);
      return this.readRegister();
    });
  }

  private readRegister(): VehicleRegister {
    return orderedRegister(vehicleRegisterSchema.parse(JSON.parse(this.register)));
  }

  stopRun(runId: string, stoppedAt: number): Promise<Run> {
    return settle(() => {
      const run = this.requireRun(runId);
      if (run.stoppedAt !== null) {
        throw new StorageError("conflict", `run ${runId} is already stopped`);
      }
      if (stoppedAt < run.startedAt) {
        throw new StorageError("invalid", `run ${runId} cannot stop before it started`);
      }
      const stopped = { ...run, stoppedAt };
      this.runs.set(runId, stopped);
      return { ...stopped };
    });
  }

  setRunNotes(runId: string, notes: string): Promise<Run> {
    return settle(() => {
      const updated = { ...this.requireRun(runId), notes };
      this.runs.set(runId, updated);
      return { ...updated };
    });
  }

  getRun(runId: string): Promise<Run | undefined> {
    return settle(() => {
      const run = this.runs.get(runId);
      return run === undefined ? undefined : { ...run };
    });
  }

  listRuns(query: RunQuery = {}): Promise<Run[]> {
    return settle(() => {
      const matching = [...this.runs.values()]
        .filter((run) => query.profile === undefined || run.profile === query.profile)
        .filter((run) => query.origin === undefined || run.origin === query.origin)
        .sort((a, b) => b.startedAt - a.startedAt || compareText(b.id, a.id));
      return page(matching, query.offset, query.limit).map((run) => ({ ...run }));
    });
  }

  deleteRun(runId: string): Promise<void> {
    return settle(() => {
      this.runs.delete(runId);
      this.samples.delete(runId);
      return;
    });
  }

  appendSamples(samples: readonly Sample[]): Promise<void> {
    return settle(() => {
      const checked = samples.map((sample) => sampleSchema.parse(sample));
      for (const sample of checked) {
        const run = this.requireRun(sample.runId);
        if (run.stoppedAt !== null) {
          throw new StorageError("conflict", `run ${run.id} is stopped and takes no more samples`);
        }
      }
      for (const sample of checked) this.requireSamples(sample.runId).push({ ...sample });
      return;
    });
  }

  readSamples(query: SampleQuery): Promise<Sample[]> {
    return settle(() => {
      const selected = inRange(this.samples.get(query.runId) ?? [], query)
        .map((sample, order) => ({ sample, order }))
        .sort((a, b) => a.sample.timestamp - b.sample.timestamp || a.order - b.order)
        .map(({ sample }) => ({ ...sample }));
      return page(selected, query.offset, query.limit);
    });
  }

  aggregate(query: AggregateQuery): Promise<SignalAggregate[]> {
    return settle(() => {
      const groups = new Map<string, { signal: string; unit: string; samples: Sample[] }>();
      for (const sample of inRange(this.samples.get(query.runId) ?? [], query)) {
        const key = JSON.stringify([sample.signal, sample.unit]);
        const group = groups.get(key) ?? { signal: sample.signal, unit: sample.unit, samples: [] };
        group.samples.push(sample);
        groups.set(key, group);
      }
      const summaries = [...groups.values()].map(({ signal, unit, samples }): SignalAggregate => {
        const numbers = samples.flatMap((sample) =>
          typeof sample.value === "number" ? [sample.value] : [],
        );
        const times = samples.map((sample) => sample.timestamp);
        return {
          signal,
          unit,
          count: samples.length,
          numericCount: numbers.length,
          min: numbers.length === 0 ? null : numbers.reduce((a, b) => Math.min(a, b)),
          max: numbers.length === 0 ? null : numbers.reduce((a, b) => Math.max(a, b)),
          mean: numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0) / numbers.length,
          firstAt: times.reduce((a, b) => Math.min(a, b)),
          lastAt: times.reduce((a, b) => Math.max(a, b)),
        };
      });
      return summaries.sort(
        (a, b) => compareText(a.signal, b.signal) || compareText(a.unit, b.unit),
      );
    });
  }

  saveScanReport(input: NewScanReport): Promise<ScanReport> {
    return settle(() => {
      const report: ScanReport = { id: this.newId(), ...newScanReportSchema.parse(input) };
      this.reports.set(report.id, report);
      this.sighted(report.origin, { vin: report.vin, plate: report.plate, at: report.takenAt });
      return { ...report };
    });
  }

  getScanReport(id: string): Promise<ScanReport | undefined> {
    return settle(() => {
      const report = this.reports.get(id);
      return report === undefined ? undefined : { ...report };
    });
  }

  listScanReports(query: ScanReportQuery = {}): Promise<ScanReportSummary[]> {
    return settle(() => {
      const matching = [...this.reports.values()]
        .filter((report) => query.profile === undefined || report.profile === query.profile)
        .sort((a, b) => b.takenAt - a.takenAt || compareText(b.id, a.id))
        .filter((report) => query.origin === undefined || report.origin === query.origin)
        .map(({ id, profile, adapter, takenAt, label, origin, vin, plate }) => ({
          id,
          profile,
          adapter,
          takenAt,
          label,
          origin,
          vin,
          plate,
        }));
      return page(matching, query.offset, query.limit);
    });
  }

  deleteScanReport(id: string): Promise<void> {
    return settle(() => {
      this.reports.delete(id);
      return;
    });
  }

  saveProfile(profile: StoredProfile): Promise<{ readonly replaced: boolean }> {
    return settle(() => {
      const replaced = this.profiles.has(profile.name);
      this.profiles.set(profile.name, { ...profile });
      return { replaced };
    });
  }

  getProfile(name: string): Promise<StoredProfile | undefined> {
    return settle(() => {
      const profile = this.profiles.get(name);
      return profile === undefined ? undefined : { ...profile };
    });
  }

  listProfiles(): Promise<StoredProfile[]> {
    return settle(() => {
      return [...this.profiles.values()]
        .sort((a, b) => compareText(a.name, b.name))
        .map((profile) => ({ ...profile }));
    });
  }

  saveCapture(capture: Capture, record: CaptureRecord): Promise<CaptureSummary> {
    return settle(() => {
      const valid = validateCapture(capture, "capture");
      if (this.captures.has(valid.id)) {
        throw new StorageError("conflict", `a capture ${valid.id} is stored already`);
      }
      const summary = captureSummary(valid, record);
      // Kept as text, so a stored capture shares nothing with the caller's objects.
      this.captures.set(valid.id, { text: JSON.stringify(valid), record: summary });
      this.sighted(summary.origin, {
        vin: summary.vin,
        plate: summary.plate,
        at: summary.startedAt,
      });
      return summary;
    });
  }

  getCapture(id: string): Promise<Capture | undefined> {
    return settle(() => {
      const stored = this.captures.get(id);
      return stored === undefined ? undefined : validateCapture(JSON.parse(stored.text), id);
    });
  }

  listCaptures(query: CaptureQuery = {}): Promise<CaptureSummary[]> {
    return settle(() => {
      const summaries = [...this.captures.values()]
        .filter((stored) => query.origin === undefined || stored.record.origin === query.origin)
        .map((stored) =>
          captureSummary(validateCapture(JSON.parse(stored.text), "capture"), stored.record),
        )
        .sort((a, b) => b.startedAt - a.startedAt || compareText(b.id, a.id));
      return page(summaries, query.offset, query.limit);
    });
  }

  deleteCapture(id: string): Promise<void> {
    return settle(() => {
      this.captures.delete(id);
      return;
    });
  }

  private requireRun(runId: string): Run {
    const run = this.runs.get(runId);
    if (run === undefined) throw new StorageError("not-found", `no run ${runId}`);
    return run;
  }

  private requireSamples(runId: string): Sample[] {
    const samples = this.samples.get(runId);
    if (samples === undefined) throw new StorageError("not-found", `no run ${runId}`);
    return samples;
  }

  savePlan(plan: StoredPlan): Promise<void> {
    return settle(() => {
      const checked = storedPlanSchema.parse(plan);
      this.plans.set(checked.id, JSON.stringify(checked));
    });
  }

  getPlan(id: string): Promise<StoredPlan | undefined> {
    return settle(() => {
      const text = this.plans.get(id);
      return text === undefined ? undefined : storedPlanSchema.parse(JSON.parse(text));
    });
  }

  listPlans(): Promise<StoredPlan[]> {
    return settle(() =>
      [...this.plans.values()]
        .map((text) => storedPlanSchema.parse(JSON.parse(text)))
        .sort((a, b) => b.updatedAt - a.updatedAt || compareText(a.id, b.id)),
    );
  }

  deletePlan(id: string): Promise<void> {
    return settle(() => {
      this.plans.delete(id);
    });
  }
}
