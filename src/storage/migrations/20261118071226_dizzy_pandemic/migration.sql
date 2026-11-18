ALTER TABLE `captures` ADD `vin` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `vin` text;--> statement-breakpoint
ALTER TABLE `scan_reports` ADD `vin` text;--> statement-breakpoint
-- Reports from before this column take the VIN their document holds, by the rule of reportVin in src/core/storage.ts: the first text among the generic OBD-II read's obd.vin, an OBD-II clear snapshot's vin and each unit's VIN identification, trimmed, in upper case and null when blank. A run or a capture keeps no VIN in what is stored of it, so theirs stay null. Each CASE tests a value's type before reading into it, since SQLite does not promise the order in which it evaluates the terms of an AND.
UPDATE `scan_reports` SET `vin` = nullif(upper(trim(coalesce(
  CASE WHEN json_type(`report`, '$.obd.vin') = 'text' THEN json_extract(`report`, '$.obd.vin') END,
  CASE WHEN json_type(`report`, '$.vin') = 'text' THEN json_extract(`report`, '$.vin') END,
  (
    SELECT `found`.`vin` FROM (
      SELECT `unit`.`key` AS `position`,
        CASE WHEN `unit`.`type` = 'object' THEN
          CASE WHEN json_type(`unit`.`value`, '$.identification.VIN.text') = 'text' THEN json_extract(`unit`.`value`, '$.identification.VIN.text') END
        END AS `vin`
      FROM json_each(CASE WHEN json_type(`report`, '$.units') = 'array' THEN json_extract(`report`, '$.units') ELSE '[]' END) AS `unit`
    ) AS `found`
    WHERE `found`.`vin` IS NOT NULL
    ORDER BY `found`.`position`
    LIMIT 1
  )
), char(32, 9, 10, 11, 12, 13))), '');
