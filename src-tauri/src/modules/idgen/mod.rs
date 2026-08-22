use crate::module::ModuleBackend;

pub struct IdGeneratorModule;
impl ModuleBackend for IdGeneratorModule {
    fn id(&self) -> &'static str {
        "idgen"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
