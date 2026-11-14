import json
import zipfile
from pathlib import Path

import pytest

from obd_read.definitions import DefinitionError, read_definitions

# A synthetic ODX fragment in the ISO 22901-1 shape; it holds no maker data.
ODX = """<?xml version="1.0" encoding="UTF-8"?>
<ODX MODEL-VERSION="2.2.0">
  <DIAG-LAYER-CONTAINER ID="DLC_1">
    <SHORT-NAME>Test</SHORT-NAME>
    <ECU-VARIANTS>
      <ECU-VARIANT ID="EV_1">
        <SHORT-NAME>TestVariantA</SHORT-NAME>
        <DIAG-DATA-DICTIONARY-SPEC>
          <DTC-DOPS><DTC-DOP ID="DD_1"><SHORT-NAME>dtcs</SHORT-NAME><DTCS>
            <DTC ID="D1"><SHORT-NAME>sensor_a</SHORT-NAME><TROUBLE-CODE>20771</TROUBLE-CODE>
              <DISPLAY-TROUBLE-CODE>5123</DISPLAY-TROUBLE-CODE><TEXT>Test sensor A fault</TEXT></DTC>
            <DTC ID="D2"><SHORT-NAME>sensor_b</SHORT-NAME><TROUBLE-CODE>36867</TROUBLE-CODE>
              <TEXT>Test sensor B fault</TEXT></DTC>
          </DTCS></DTC-DOP></DTC-DOPS>
        </DIAG-DATA-DICTIONARY-SPEC>
        <DIAG-COMMS>
          <DIAG-SERVICE ID="S1"><SHORT-NAME>read_part</SHORT-NAME><LONG-NAME>Read test part number</LONG-NAME>
            <REQUEST-REF ID-REF="R1"/></DIAG-SERVICE>
          <DIAG-SERVICE ID="S2"><SHORT-NAME>variable</SHORT-NAME><REQUEST-REF ID-REF="R2"/></DIAG-SERVICE>
        </DIAG-COMMS>
        <REQUESTS>
          <REQUEST ID="R1"><SHORT-NAME>r1</SHORT-NAME><PARAMS>
            <PARAM><SHORT-NAME>sid</SHORT-NAME><BYTE-POSITION>0</BYTE-POSITION><CODED-VALUE>26</CODED-VALUE>
              <DIAG-CODED-TYPE><BIT-LENGTH>8</BIT-LENGTH></DIAG-CODED-TYPE></PARAM>
            <PARAM><SHORT-NAME>id</SHORT-NAME><BYTE-POSITION>1</BYTE-POSITION><CODED-VALUE>134</CODED-VALUE>
              <DIAG-CODED-TYPE><BIT-LENGTH>8</BIT-LENGTH></DIAG-CODED-TYPE></PARAM>
          </PARAMS></REQUEST>
          <REQUEST ID="R2"><SHORT-NAME>r2</SHORT-NAME><PARAMS>
            <PARAM><SHORT-NAME>sid</SHORT-NAME><BYTE-POSITION>0</BYTE-POSITION>
              <DIAG-CODED-TYPE><BIT-LENGTH>8</BIT-LENGTH></DIAG-CODED-TYPE></PARAM>
          </PARAMS></REQUEST>
        </REQUESTS>
      </ECU-VARIANT>
      <ECU-VARIANT ID="EV_2">
        <SHORT-NAME>TestVariantB</SHORT-NAME>
        <DIAG-DATA-DICTIONARY-SPEC>
          <DTC-DOPS><DTC-DOP ID="DD_2"><SHORT-NAME>dtcs</SHORT-NAME><DTCS>
            <DTC ID="D3"><SHORT-NAME>x</SHORT-NAME><TROUBLE-CODE>20771</TROUBLE-CODE>
              <TEXT>A different text</TEXT></DTC>
          </DTCS></DTC-DOP></DTC-DOPS>
        </DIAG-DATA-DICTIONARY-SPEC>
      </ECU-VARIANT>
    </ECU-VARIANTS>
  </DIAG-LAYER-CONTAINER>
</ODX>
"""

TRAFO = {
    "TrafoVersion": "x",
    "Variants": [
        {
            "VariantName": "TestVariantA",
            "DTCs": [
                {"Code": "5123", "Desc": "Test sensor A fault"},
                {"Code": "DTC_NOT_HEX", "Desc": "Unusable code"},
                {"Code": "P0420", "Desc": "Test catalyst text"},
            ],
            "DiagServices": [
                {
                    "DiagServiceName": "RD_part",
                    "Desc": "Read test part number",
                    "RequestBytes": "1A 86 ",
                },
                {"DiagServiceName": "bad", "Desc": "x", "RequestBytes": "ZZ"},
            ],
        },
        {"VariantName": "TestVariantB", "DTCs": [], "DiagServices": []},
    ],
}


def test_odx_codes_and_requests(tmp_path: Path) -> None:
    path = tmp_path / "test.odx-d"
    path.write_text(ODX)
    found = read_definitions(path, "TestVariantA")
    assert found.codes == {"5123": "Test sensor A fault", "9003": "Test sensor B fault"}
    assert found.values == {"1A86": "Read test part number"}


def test_odx_without_a_variant_reads_every_layer_and_reports_conflicts(tmp_path: Path) -> None:
    path = tmp_path / "test.odx-d"
    path.write_text(ODX)
    found = read_definitions(path)
    assert found.codes["5123"] == "Test sensor A fault"
    assert found.conflicts == [
        "fault code 5123: kept 'Test sensor A fault', ignored 'A different text'"
    ]


def test_odx_inside_a_pdx_archive(tmp_path: Path) -> None:
    path = tmp_path / "test.pdx"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("one.odx-d", ODX)
        archive.writestr("index.xml.txt", "ignored")
    assert read_definitions(path, "TestVariantA").codes["9003"] == "Test sensor B fault"


def test_an_unknown_variant_is_an_error(tmp_path: Path) -> None:
    path = tmp_path / "test.odx-d"
    path.write_text(ODX)
    with pytest.raises(DefinitionError, match="named Nope"):
        read_definitions(path, "Nope")


def test_entity_declarations_are_refused(tmp_path: Path) -> None:
    path = tmp_path / "bomb.odx"
    path.write_text('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>')
    with pytest.raises(DefinitionError, match="entity"):
        read_definitions(path)


def test_trafo_json(tmp_path: Path) -> None:
    path = tmp_path / "test.json"
    path.write_text(json.dumps(TRAFO))
    found = read_definitions(path, "TestVariantA")
    assert found.codes == {"5123": "Test sensor A fault", "P0420": "Test catalyst text"}
    assert found.values == {"1A86": "Read test part number"}
    assert found.skipped == ["TestVariantA: code 'DTC_NOT_HEX' is not hexadecimal or an SAE code"]


def test_cbf_files_are_not_read_directly(tmp_path: Path) -> None:
    path = tmp_path / "x.cbf"
    path.write_bytes(b"\x00")
    with pytest.raises(DefinitionError, match="Trafo"):
        read_definitions(path)


def test_json_that_is_not_trafo_output_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "x.json"
    path.write_text("{}")
    with pytest.raises(DefinitionError):
        read_definitions(path)
