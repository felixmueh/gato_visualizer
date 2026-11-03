"""Authoritative current-run history and indexed full/compact playback reads.

The HTTP service owns each store. Its lock publishes complete encoded packets
and captures committed read prefixes; file reads and decoding run outside it.
Full records and compact motion records always share one committed cursor.
"""
from __future__ import annotations

from copy import deepcopy
import errno
import json
from pathlib import Path
import threading
import time

from runtime_files import ENVIRONMENT as RUNTIME_ENVIRONMENT, ended_owner, owner_tag

MAX_HISTORY_PAGE_RECORDS = 2048
MAX_PLAYBACK_PLANS = 32
PLAYBACK_PLAN_FIELDS = frozenset((
    'type', 'origin', 'seq', 'id', 'N', 'dt_s', 'sim_time_s', 'request_time_s',
    'plan_origin_time_s', 'measured_time_s', 'available_time_s',
    'scheduled_activation_time_s', 'solve_latency_s', 'latency_overrun',
    'stats', 'generation', 'settings_version',
))
NO_SEGMENT = ("Live history has no segment header; histories recorded before the "
              "2026-10-23 format change cannot be loaded")


class HistoryGenerationError(ValueError):
    pass


def playback_record(record):
    """Preserve motion/events while representing a prediction by its identity."""
    return (dict({key: value for key, value in record.items() if key in PLAYBACK_PLAN_FIELDS}, summary=True)
            if record.get('type') == 'plan' and record.get('origin') != 'preview' else record)


class HistoryStore:
    """Append-only JSONL; bounded pages and a compact byte-offset index.

    One file per generation; its first record is the segment header holding the
    constant context. HTTP never waits for a GPU/native solver call.

    Only the current run is kept (Felix, 2026-10-23): a generation's file is deleted
    when it stops being current (a new generation, close at shutdown or restart),
    and files left by earlier server runs (by owner pid) at start. Readers of a
    replaced generation fail with HistoryGenerationError. `kept` is the hook for
    runs retained on purpose later (a comparison feature); nothing adds to it yet.
    """
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.generation = 0
        self.lock = threading.RLock()
        self.stream = None
        self.path = None
        self.playback_stream = None
        self.playback_path = None
        self.kept = set()
        for path in self.directory.glob("history-*.jsonl"):
            if ended_owner(path.name.split("-")[1]):
                path.unlink(missing_ok=True)
        self.reset(0)

    def _discard(self, path):
        if path is not None and path not in self.kept:
            path.unlink(missing_ok=True)

    def reset(self, generation):
        with self.lock:
            if self.stream:
                self.stream.close()
            if self.playback_stream:
                self.playback_stream.close()
            self._discard(self.path)
            self._discard(self.playback_path)
            self.generation = generation
            self.offsets = []
            self.playback_offsets = []
            self.plan_offsets = {}
            self.segment = None
            self.state_count = 0
            self.end_time = 0.
            self.complete = True
            self.path = self.directory / f"history-{owner_tag()}-{time.time_ns()}-g{generation}.jsonl"
            self.stream = self.path.open("w+b")
            self.playback_path = self.path.with_suffix('.playback.jsonl')
            self.playback_stream = self.playback_path.open('w+b')

    @staticmethod
    def plan_identity(record):
        identifier = str(record.get("id", record.get("seq")))
        return f"preview:{identifier}" if record.get("origin") == "preview" else identifier

    @staticmethod
    def encode(records):
        result = []
        for record in records:
            encoded = json.dumps(record, allow_nan=False, separators=(",", ":")).encode()+b'\n'
            is_plan = record.get('type') == 'plan'
            compact = (json.dumps(playback_record(record),
                                  allow_nan=False, separators=(',', ':')).encode()+b'\n'
                       if is_plan else encoded)
            result.append((encoded, float(record.get('sim_time_s', record.get('end_time_s', 0))),
                           record.get('type') == 'state', HistoryStore.plan_identity(record) if is_plan else None,
                           record if record.get('type') == 'segment' else None, compact))
        return result

    def append(self, records):
        self.append_encoded(self.encode(records))

    def append_encoded(self, encoded_records):
        encoded_records = list(encoded_records)
        if not encoded_records:
            return
        # Assemble the packet before taking the store lock. The receiver already
        # encoded each record outside the Live lock; file I/O is one batch, not
        # one buffered write/tell pair per physics state.
        payload = b"".join(record[0] for record in encoded_records)
        playback_payload = b''.join(record[5] for record in encoded_records)
        relative_offsets, playback_offsets, plans = [], [], []
        offset = playback_offset = state_count = 0
        end_time = 0.
        segment = next((record[4] for record in encoded_records if record[4] is not None), None)
        for index, (encoded, timestamp, is_state, plan_id, _, compact) in enumerate(encoded_records):
            relative_offsets.append(offset)
            playback_offsets.append(playback_offset)
            if plan_id is not None:
                plans.append((plan_id, index, offset, len(encoded)))
            offset += len(encoded)
            playback_offset += len(compact)
            state_count += is_state
            end_time = max(end_time, timestamp)
        with self.lock:
            start = self.stream.tell()
            playback_start = self.playback_stream.tell()
            try:
                self.stream.write(payload)
                self.stream.flush()
                self.playback_stream.write(playback_payload)
                self.playback_stream.flush()
            except OSError as exc:
                # Neither index may expose a partial packet. Keep the two files
                # on the same committed cursor even if the second write fails.
                self.stream.seek(start)
                self.stream.truncate()
                self.playback_stream.seek(playback_start)
                self.playback_stream.truncate()
                if exc.errno == errno.ENOSPC:
                    raise OSError(exc.errno, f"The RAM-backed runtime directory {self.directory.parent} is full; "
                                  f"Reset, shorten the run or set {RUNTIME_ENVIRONMENT}") from exc
                raise
            cursor = len(self.offsets)
            self.offsets.extend(start + offset for offset in relative_offsets)
            self.playback_offsets.extend(playback_start + offset for offset in playback_offsets)
            for identifier, index, offset, size in plans:
                self.plan_offsets.setdefault(identifier, (cursor + index, start + offset, size))
            self.end_time = max(self.end_time, end_time)
            self.state_count += state_count
            if self.segment is None:
                self.segment = segment

    def metadata(self):
        with self.lock:
            return dict(type="history", generation=self.generation, history_cursor=len(self.offsets),
                        history_end_s=self.end_time, complete=self.complete)

    def plot_source(self, generation):
        """Capture only committed storage identity; plotting reads outside locks."""
        with self.lock:
            if generation != self.generation:
                raise HistoryGenerationError(f"History changed; current generation={self.generation}")
            return dict(kind="live", generation=generation, path=str(self.path),
                        cursor=len(self.offsets), byte_end=self.stream.tell(),
                        complete=self.complete)

    def open_committed_prefix(self, generation):
        """Open under the store lock; decoding/export runs outside it, like pages."""
        with self.lock:
            if generation != self.generation:
                raise HistoryGenerationError(f"History changed; current generation={self.generation}")
            if self.segment is None:
                raise ValueError(NO_SEGMENT)
            if self.state_count < 2:
                raise ValueError("Freeze needs at least two recorded states")
            return dict(reader=self.path.open("rb"), byte_end=self.stream.tell(), cursor=len(self.offsets),
                        complete=self.complete)

    def _page_encoded(self, generation, after, limit, *, playback=False):
        # Snapshot one bounded committed byte window and open it, then read outside
        # locks. The open file stays readable when a newer generation replaces (and
        # deletes) it; later appends cannot enter this page.
        with self.lock:
            if generation != self.generation:
                raise HistoryGenerationError(f"History changed; current generation={self.generation}")
            if (type(after) is not int or type(limit) is not int or
                    not 0 <= after <= len(self.offsets) or not 1 <= limit <= MAX_HISTORY_PAGE_RECORDS):
                raise ValueError(f"after must be an existing history cursor; limit must be within [1,{MAX_HISTORY_PAGE_RECORDS}]")
            stop = min(after+limit, len(self.offsets))
            offsets = self.playback_offsets if playback else self.offsets
            path, stream = (self.playback_path, self.playback_stream) if playback else (self.path, self.stream)
            offset = offsets[after] if stop > after else None
            end = offsets[stop] if stop < len(offsets) else stream.tell()
            complete, end_time = self.complete, self.end_time
            reader = path.open("rb") if offset is not None else None
        records = []
        if offset is not None:
            with reader:
                reader.seek(offset)
                encoded = reader.read(end-offset)
            records = encoded.split(b"\n")[:-1]
            if len(encoded) != end-offset or not encoded.endswith(b"\n") or len(records) != stop-after:
                raise ValueError("Committed Live history page is incomplete")
        return dict(generation=generation, next_cursor=stop, complete=complete,
                    records=records, history_end_s=end_time)

    def page(self, generation, after, limit):
        page = self._page_encoded(generation, after, limit)
        page["records"] = [json.loads(record) for record in page["records"]]
        return page

    def page_json(self, generation, after, limit, *, playback=False):
        """Reuse validated JSONL records without decoding and re-encoding them."""
        page = self._page_encoded(generation, after, limit, playback=playback)
        head = {key: page[key] for key in ("generation", "next_cursor", "complete")}
        encode = lambda value: json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
        return (encode(head)[:-1] + b',"records":[' + b",".join(page["records"]) + b'],' +
                encode(dict(history_end_s=page["history_end_s"]))[1:])

    def plans_json(self, generation, identifiers):
        """Read only indexed complete predictions; never scan the history."""
        if (not isinstance(identifiers, (list, tuple)) or not 1 <= len(identifiers) <= MAX_PLAYBACK_PLANS
                or any(type(item) not in (str, int) or not str(item) for item in identifiers)):
            raise ValueError(f'Select between 1 and {MAX_PLAYBACK_PLANS} retained plan IDs')
        identifiers = [str(item) for item in identifiers]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError('Plan IDs must be distinct')
        with self.lock:
            if generation != self.generation:
                raise HistoryGenerationError(f'History changed; current generation={self.generation}')
            indexed = [self.plan_offsets.get(item) for item in identifiers]
            byte_end = self.stream.tell()
            if any(item is None or item[0] >= len(self.offsets) or item[1]+item[2] > byte_end for item in indexed):
                raise ValueError('Selected solve is not retained in this source')
            reader = self.path.open('rb')
        records = []
        with reader:
            for _, offset, size in indexed:
                reader.seek(offset)
                encoded = reader.read(size)
                if len(encoded) != size or not encoded.endswith(b'\n'):
                    raise ValueError('Committed Live history prefix is incomplete')
                records.append(encoded[:-1])
        head = json.dumps(dict(generation=generation), separators=(',', ':')).encode()
        return head[:-1]+b',"plans":['+b','.join(records)+b']}'

    def selected_plan(self, descriptor, identifier):
        """Read one retained plan with its segment's context, never scanning or
        decoding unrelated physics states."""
        if type(identifier) not in (str, int) or not str(identifier):
            raise ValueError("Select a retained solve id")
        identifier = str(identifier)
        with self.lock:
            if (type(descriptor.get("generation")) is not int or
                    descriptor["generation"] != self.generation or descriptor.get("path") != str(self.path)):
                raise HistoryGenerationError(f"History changed; current generation={self.generation}")
            cursor, byte_end = descriptor.get("cursor"), descriptor.get("byte_end")
            if (descriptor.get("kind") != "live" or type(cursor) is not int or
                    not 0 <= cursor <= len(self.offsets) or type(byte_end) is not int):
                raise ValueError("Invalid committed Live history prefix")
            expected_end = self.offsets[cursor] if cursor < len(self.offsets) else self.stream.tell()
            if byte_end != expected_end:
                raise ValueError("Invalid committed Live history prefix")
            indexed = self.plan_offsets.get(identifier)
            if indexed is None or indexed[0] >= cursor or indexed[1] + indexed[2] > byte_end:
                raise ValueError("Selected solve is not retained in this source")
            _, offset, size = indexed
            segment = self.segment
            if segment is None:
                raise ValueError(NO_SEGMENT)
            # Open under the lock: a concurrently replaced (deleted) file stays
            # readable, like history pages. Disk I/O and JSON decoding stay outside.
            reader = self.path.open("rb")
        with reader:
            reader.seek(offset)
            encoded = reader.read(size)
        if len(encoded) != size or not encoded.endswith(b"\n"):
            raise ValueError("Committed Live history prefix is incomplete")
        plan = json.loads(encoded)
        if not isinstance(plan, dict) or plan.get("type") != "plan" or self.plan_identity(plan) != identifier:
            raise ValueError("Selected retained solve identity changed")
        return dict(deepcopy(segment["context"]), **plan)

    def close(self):
        """Close at shutdown or restart: the current run stops being current."""
        with self.lock:
            if self.stream:
                self.stream.close()
                self.stream = None
            if self.playback_stream:
                self.playback_stream.close()
                self.playback_stream = None
            self._discard(self.path)
            self._discard(self.playback_path)
