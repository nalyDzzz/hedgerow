/** How a script is split into statements, and which of them Run picks for a cursor. */
import { describe, expect, it } from 'vitest'
import { MYSQL, splitStatements, statementAt, statementRanges } from './sql'

/** The statement Run would execute with the cursor where `|` stands in `marked`, or null for none. */
function under(marked: string): string | null {
  const position = marked.indexOf('|')
  const text = marked.replace('|', '')
  const ranges = statementRanges(MYSQL.language.parser.parse(text), text)
  const range = statementAt(ranges, (from, to) => text.slice(from, to), position)
  return range ? text.slice(range.from, range.to) : null
}

const PURGE = `CREATE PROCEDURE purge()
BEGIN
  DELETE FROM audit_log WHERE created < NOW() - INTERVAL 90 DAY;
  DELETE FROM sessions;
END`

describe('splitting a script into statements', () => {
  it('splits at semicolons, with or without one after the last statement', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(splitStatements('SELECT 1;\n\nSELECT 2;\n')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(splitStatements(';;SELECT 1;;')).toEqual(['SELECT 1'])
  })

  it('does not take a semicolon in a string, a name or a comment for the end', () => {
    expect(splitStatements("SELECT 'a;b', \"c;d\", `e;f` FROM t; -- g;h\nSELECT 2; # i;j\nSELECT 3 /* k;l */;")).toEqual([
      "SELECT 'a;b', \"c;d\", `e;f` FROM t",
      'SELECT 2',
      'SELECT 3 /* k;l */',
    ])
    expect(splitStatements("SELECT 1; -- don't\nDELETE FROM t WHERE id = 1;")).toEqual([
      'SELECT 1',
      'DELETE FROM t WHERE id = 1',
    ])
  })

  it('reads a quote after a backslash as part of the string, as MySQL does', () => {
    expect(splitStatements("SELECT 'it\\'s; fine'; SELECT 2;")).toEqual(["SELECT 'it\\'s; fine'", 'SELECT 2'])
    expect(splitStatements("SELECT 'it\\'s' AS a;\nSELECT 2 AS b;")).toEqual(["SELECT 'it\\'s' AS a", 'SELECT 2 AS b'])
    // What follows the semicolon inside the string is text, not a statement.
    expect(splitStatements("INSERT INTO notes VALUES ('don\\'t; DELETE FROM users;');")).toEqual([
      "INSERT INTO notes VALUES ('don\\'t; DELETE FROM users;')",
    ])
    // A backslash written twice is a backslash, and the quote after it ends the string.
    expect(splitStatements("SELECT 'C:\\\\'; SELECT 2")).toEqual(["SELECT 'C:\\\\'", 'SELECT 2'])
  })

  it('reads a backslash as a plain character for a session that does', () => {
    // Under NO_BACKSLASH_ESCAPES the string ends at the quote after the backslash.
    expect(splitStatements("SELECT 'a\\'; SELECT 2;", false)).toEqual(["SELECT 'a\\'", 'SELECT 2'])
    expect(splitStatements("SELECT 'C:\\\\'; SELECT 2", false)).toEqual(["SELECT 'C:\\\\'", 'SELECT 2'])
    // Read the usual way, the quote is part of the string, which then never ends.
    expect(splitStatements("SELECT 'a\\'; SELECT 2;", true)).toEqual(["SELECT 'a\\'; SELECT 2;"])
    // And what the usual reading takes for one string is two statements here, the second one broken.
    expect(splitStatements("SELECT 'it\\'s; fine'; SELECT 2;", false)).toEqual(["SELECT 'it\\'s", "fine'; SELECT 2;"])
  })

  it('leaves a comment before a statement out of it', () => {
    expect(splitStatements('-- switch\nUSE other_db;\n/* note */ USE third_db;')).toEqual(['USE other_db', 'USE third_db'])
  })

  it('keeps a comment that the server runs', () => {
    expect(splitStatements('/*!40101 SET NAMES utf8mb4 */;\nSELECT 1;')).toEqual([
      '/*!40101 SET NAMES utf8mb4 */',
      'SELECT 1',
    ])
  })

  it('sends text that holds no statement as it is, for the server to refuse', () => {
    expect(splitStatements('-- just a note')).toEqual(['-- just a note'])
    expect(splitStatements('  \n ')).toEqual([])
  })

  it('takes BEGIN on its own for the start of a transaction', () => {
    expect(splitStatements('BEGIN;\nUPDATE t SET a = 1 WHERE id = 2;\nCOMMIT;')).toEqual([
      'BEGIN',
      'UPDATE t SET a = 1 WHERE id = 2',
      'COMMIT',
    ])
  })
})

describe('the definition of a stored program', () => {
  it('is one statement, whatever semicolons its body holds', () => {
    expect(splitStatements(`${PURGE};\nCALL purge();`)).toEqual([PURGE, 'CALL purge()'])
    expect(splitStatements(PURGE)).toEqual([PURGE])
  })

  it('may name who defines it, and be written in any case', () => {
    const sql = "create definer = `root`@`%` procedure p(in n int)\nbegin\n  select n;\n  select n + 1;\nend"
    expect(splitStatements(`${sql};\nselect 1`)).toEqual([sql, 'select 1'])
  })

  it('ends at its first semicolon when its body is one plain statement', () => {
    expect(splitStatements('CREATE PROCEDURE p() SELECT IF(a, 1, 2) FROM t; SELECT 2;')).toEqual([
      'CREATE PROCEDURE p() SELECT IF(a, 1, 2) FROM t',
      'SELECT 2',
    ])
    expect(splitStatements('CREATE FUNCTION f(a INT) RETURNS INT DETERMINISTIC RETURN a + 1; SELECT f(1);')).toEqual([
      'CREATE FUNCTION f(a INT) RETURNS INT DETERMINISTIC RETURN a + 1',
      'SELECT f(1)',
    ])
    expect(
      splitStatements('CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET NEW.made = NOW(); SELECT 1;'),
    ).toEqual(['CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW SET NEW.made = NOW()', 'SELECT 1'])
    expect(splitStatements('ALTER EVENT e DISABLE; SELECT 1;')).toEqual(['ALTER EVENT e DISABLE', 'SELECT 1'])
  })

  it('may have a body that is a statement holding statements, without BEGIN', () => {
    const trigger = `CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW
IF NEW.x IS NULL THEN
  SET NEW.x = 1;
  SET NEW.y = 2;
END IF`
    expect(splitStatements(`${trigger};\nSELECT 1;`)).toEqual([trigger, 'SELECT 1'])
    const event = `CREATE EVENT sweep ON SCHEDULE EVERY 1 DAY DO
WHILE ROW_COUNT() > 0 DO
  DELETE FROM log LIMIT 1000;
END WHILE`
    expect(splitStatements(`${event};\nSELECT 1;`)).toEqual([event, 'SELECT 1'])
  })

  it('is read through every kind of statement a body can hold', () => {
    const body = `CREATE FUNCTION grade(score INT) RETURNS SET('a','b') CHARSET utf8mb4
    READS SQL DATA
    COMMENT 'has a ; in it'
main: BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;
  DROP TEMPORARY TABLE IF EXISTS scratch;
  IF score > 90 THEN
    SET @g = IF(score > 95, 'a', 'b');
  ELSEIF (score > 50) THEN
    SET @g = CASE WHEN score > 70 THEN 'c' ELSE 'd' END;
  ELSE
    BEGIN
      SET @g = 'e';
    END;
  END IF;
  CASE score
    WHEN 1 THEN SET @n = 1; SET @m = 1;
    WHEN 2 THEN SET @n = 2;
    ELSE SET @n = 3;
  END CASE;
  CASE WHEN CASE WHEN score > 1 THEN 1 ELSE 0 END = 1 THEN SET @n = 4; END CASE;
  tries: LOOP
    SET score = score - 1;
    IF score < 0 THEN LEAVE tries; END IF;
  END LOOP tries;
  WHILE score < 10 DO
    SET score = score + 1;
  END WHILE;
  REPEAT
    SET score = score - 1;
  UNTIL score = 0 END REPEAT;
  RETURN @g;
END main`
    expect(splitStatements(`${body};\nSELECT grade(1);`)).toEqual([body, 'SELECT grade(1)'])
  })

  it('is not what a CREATE TABLE with such words in it is', () => {
    expect(splitStatements('CREATE TABLE t (`begin` INT, event INT, `end` INT); SELECT 1;')).toEqual([
      'CREATE TABLE t (`begin` INT, event INT, `end` INT)',
      'SELECT 1',
    ])
  })

  it('runs to the end of the script while its body is not closed yet', () => {
    const open = 'CREATE PROCEDURE p()\nBEGIN\n  DELETE FROM a;\n  DELETE FROM b;'
    expect(splitStatements(open)).toEqual([open])
    // Whatever follows is still inside the body, as far as anyone can tell.
    expect(splitStatements(`${open}\nSELECT 1;`)).toEqual([`${open}\nSELECT 1;`])
  })
})

describe('a script that sets its own delimiter', () => {
  it('is split at that delimiter, and the line that sets it is not sent', () => {
    const script = `DELIMITER $$
CREATE PROCEDURE p()
BEGIN
  DELETE FROM a;
  DELETE FROM b;
END$$
DELIMITER ;
SELECT 1;
SELECT 2;`
    expect(splitStatements(script)).toEqual([
      'CREATE PROCEDURE p()\nBEGIN\n  DELETE FROM a;\n  DELETE FROM b;\nEND',
      'SELECT 1',
      'SELECT 2',
    ])
  })

  it('does not take the delimiter inside a string or a comment for the end', () => {
    const script = "delimiter //\nSELECT '//' AS a; -- not // here\nSELECT 2 //\nSELECT 3 //"
    expect(splitStatements(script)).toEqual(["SELECT '//' AS a; -- not // here\nSELECT 2", 'SELECT 3'])
  })
})

describe('the statement Run picks for a cursor', () => {
  it('is the one the cursor is in, or stands right after', () => {
    expect(under('SELECT 1;\nDELETE FROM t\nWHE|RE id = 2;\nSELECT 3;')).toBe('DELETE FROM t\nWHERE id = 2')
    expect(under('SELECT 1;| SELECT 2;')).toBe('SELECT 1')
    expect(under('SELECT 1;   |  -- note\nSELECT 2;')).toBe('SELECT 1')
    expect(under('SELECT 1\n|')).toBe('SELECT 1')
  })

  it('is the whole definition for a cursor anywhere in the body of a stored program', () => {
    expect(under(PURGE.replace('DELETE FROM sessions', 'DELETE FROM |sessions') + ';')).toBe(PURGE)
    expect(under(`DELIMITER $$\n${PURGE.replace('FROM sessions', 'FROM |sessions')}$$\nDELIMITER ;`)).toBe(PURGE)
  })

  it('is never text inside a string', () => {
    const sql = "INSERT INTO notes VALUES ('don\\'t; DELETE FROM users;')"
    expect(under(`${sql.replace('FROM users', 'FROM |users')};`)).toBe(sql)
  })

  it('is the next one for a cursor on the lines just above it', () => {
    expect(under('SELECT 1;\n\n-- the one to |run\nSELECT 2;')).toBe('SELECT 2')
    expect(under('SELECT 1;\n\n|\nSELECT 2;')).toBe('SELECT 2')
  })

  it('is nothing for a cursor that an empty line keeps apart from every statement', () => {
    expect(under(`DELETE FROM users WHERE disabled = 1;${'\n'.repeat(30)}|`)).toBeNull()
    expect(under('DELETE FROM users WHERE disabled = 1\n\n|')).toBeNull()
    expect(under('SELECT 1;\n\n|\n\nDELETE FROM users;')).toBeNull()
    expect(under('|\n\nDELETE FROM users;')).toBeNull()
    expect(under('|')).toBeNull()
  })
})
