/**
 * 「数据源」分类的草稿读写与候选投影（docs/design/sandbox-data-sources.md §5）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DATA_SOURCES_MAX,
  dataSourceCandidates,
  dataSourcesMaxItems,
  dataSourcesOf,
  dataSourceStructureIssues,
  setDataSources,
} from '../src/pages/settings/dataSourceHelpers.ts';
import { delegationRows } from '../src/pages/settings/delegationHelpers.ts';

describe('dataSources draft', () => {
  it('reads ids and treats absent or malformed values as empty', () => {
    assert.deepEqual(dataSourcesOf({}), []);
    assert.deepEqual(dataSourcesOf({ dataSources: [{ id: 'hr' }, { id: 'sales' }] }), ['hr', 'sales']);
    assert.deepEqual(dataSourcesOf({ dataSources: { id: 'hr' } }), []);
  });

  it('writes [{ id }] in selection order, keeps extra fields for the server to judge, never mutates the source', () => {
    const source = { schemaVersion: 1, dataSources: [{ id: 'hr', future: true }] };
    const next = setDataSources(source, ['hr', 'sales']);
    assert.deepEqual(next.dataSources, [{ id: 'hr', future: true }, { id: 'sales' }]);
    assert.deepEqual(source.dataSources, [{ id: 'hr', future: true }]);
    assert.equal(next.schemaVersion, 1);
  });

  it('drops the key once the list is empty', () => {
    assert.equal('dataSources' in setDataSources({ dataSources: [{ id: 'hr' }] }, []), false);
  });

  it('pauses the section on a malformed structure instead of overwriting it', () => {
    assert.equal(dataSourceStructureIssues({ dataSources: ['hr'] }).length, 1);
    assert.equal(dataSourceStructureIssues({ dataSources: 'hr' }).length, 1);
    assert.deepEqual(dataSourceStructureIssues({ dataSources: [{ id: 'hr' }] }), []);
    const broken = { dataSources: ['hr'] };
    assert.deepEqual(setDataSources(broken, ['sales']), broken);
  });
});

describe('dataSources candidates', () => {
  it('projects the catalog from config-options and keeps server order', () => {
    const items = dataSourceCandidates({
      dataSources: [
        { id: 'hr', label: '员工库', description: 'HR 主数据', engine: 'mysql' },
        { id: 'sales', label: '', description: '' },
        { label: 'no id' },
      ],
    });
    assert.deepEqual(items, [
      { id: 'hr', label: '员工库', description: 'HR 主数据', selectable: true, note: 'MYSQL' },
      { id: 'sales', label: 'sales', description: '', selectable: true },
    ]);
    assert.deepEqual(dataSourceCandidates(undefined), []);
  });

  it('keeps an unregistered draft id as a remove-only row', () => {
    const rows = delegationRows(['gone'], dataSourceCandidates({ dataSources: [{ id: 'hr', label: 'HR' }] }));
    assert.deepEqual(rows.map((r) => [r.id, r.checked, r.stale]), [['hr', false, false], ['gone', true, true]]);
  });

  it('reads the limit from fieldSupport with a server-default fallback', () => {
    assert.equal(dataSourcesMaxItems({ dataSources: { maxItems: 4 } }), 4);
    assert.equal(dataSourcesMaxItems(undefined), DEFAULT_DATA_SOURCES_MAX);
  });
});
