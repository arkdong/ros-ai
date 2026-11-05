import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutPaths } from '../src/server/report-record.js';

test('an exported report keeps file names but no folder, also folders whose names hold spaces', () => {
  for (const [text, kept] of [
    ['/Users/Adam Smith/Google Drive/Secret Merger/survey.csv', 'survey.csv'],
    ['C:\\Users\\Adam Smith\\Documents\\Q3 Plan\\data.xlsx', 'data.xlsx'],
    ['/Users/ada/Library/CloudStorage/GoogleDrive-ada@example.com/My Drive/notes.md', 'notes.md'],
    ['Read /Users/ada/data.csv and /tmp/x.txt', 'Read data.csv and x.txt'],
    ['/Users/ada/My Data/my file.csv was read', 'my file.csv was read'],
    ['error at /input/program.py line 3', 'error at program.py line 3'],
    ['https://example.com/a/b.csv', 'https://example.com/a/b.csv'],
    ['3/4 of the rows', '3/4 of the rows'],
  ]) assert.equal(withoutPaths(text), kept, text);
});
