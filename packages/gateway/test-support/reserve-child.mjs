import { Journal, digest } from '../src/journal.ts';
const [path,id] = process.argv.slice(2);
const journal = new Journal(path);
try {
  journal.reserve({id,mandateId:'m',digest:digest(id),network:'eip155:84532',asset:'USDC',amount:'50',
    limits:{ceilingBaseUnits:'500',perCallBaseUnits:'50',windowBaseUnits:'500',windowMs:3600000}});
  process.stdout.write('reserved');
} catch (e) {
  if (!/budget/.test(e.message)) throw e;
  process.stdout.write('rejected');
} finally { journal.close(); }
