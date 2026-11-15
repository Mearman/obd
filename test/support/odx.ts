/** A synthetic ODX fragment in the ISO 22901-1 shape; it holds no maker data. */
export const ODX = `<?xml version="1.0" encoding="UTF-8"?>

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

`;

/** The JSON Trafo writes for a CBF file, reduced to what the reader uses. */
export const TRAFO = {
  TrafoVersion: "x",
  Variants: [
    {
      VariantName: "TestVariantA",
      DTCs: [
        { Code: "5123", Desc: "Test sensor A fault" },
        { Code: "DTC_NOT_HEX", Desc: "Unusable code" },
        { Code: "P0420", Desc: "Test catalyst text" },
      ],
      DiagServices: [
        { DiagServiceName: "RD_part", Desc: "Read test part number", RequestBytes: "1A 86 " },
        { DiagServiceName: "bad", Desc: "x", RequestBytes: "ZZ" },
      ],
    },
    { VariantName: "TestVariantB", DTCs: [], DiagServices: [] },
  ],
};
